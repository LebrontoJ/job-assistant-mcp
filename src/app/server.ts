import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ApplicationStore } from '../store/applications.js';
import { STATUSES, StatusSchema } from '../store/applications.js';
import type { PendingOperation } from '../store/operations.js';
import { analyseTask, readTool, type TaskReport } from '../agent/task.js';
import type { LLMClient } from '../agent/llm/types.js';
import { ExecutionBudget, ToolExecutor, failureKind } from '../agent/execution.js';
import { contextualTracer, tracedExecution, traceStage, type Tracer } from '../agent/trace.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0,10) === s, 'Invalid calendar date');
const previewInput = z.union([
  z.object({ taskId: z.string().uuid(), company: z.string().trim().min(1).max(200), role: z.string().trim().min(1).max(200), status: StatusSchema, url: z.string().url().optional(), nextFollowUp: date.optional() }).strict(),
  z.object({ id: z.string(), status: StatusSchema }).strict(),
]);
const decisionInput = z.object({ operationId: z.string().uuid(), decision: z.enum(['approve', 'cancel']) }).strict();
interface AppOptions { client: Client; store: ApplicationStore; llm?: LLMClient; tracer?: Tracer }
interface Preview { operation: PendingOperation; response: Record<string, unknown>; taskId: string; decision?: 'approve' | 'cancel' }
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
async function body(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Use application/json.');
  let text = '';
  for await (const chunk of req) {
    text += chunk.toString();
    if (Buffer.byteLength(text) > 80_000) throw new HttpError(413, 'Request too large.');
  }
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'Invalid JSON.'); }
}
const send = (res: ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};

/** Local, single-user host. The decision endpoint is the human boundary; no model can call it as a tool. */
export function createApp(opts: AppOptions) {
  const token = randomUUID();
  const tasks = new Map<string, { report: TaskReport; created: number }>();
  const previews = new Map<string, Preview>();
  let activeAnalyses = 0;
  const app = createServer(async (req, res) => {
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    const requestId = randomUUID();
    let taskId: string = requestId;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const address = app.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      const origin = `http://127.0.0.1:${port}`;
      if (req.headers.host !== `127.0.0.1:${port}`) throw new HttpError(403, 'Local host required.');
      if (req.headers.origin && req.headers.origin !== origin) throw new HttpError(403, 'Cross-origin request denied.');
      const path = new URL(req.url ?? '/', origin).pathname;
      if (req.method === 'GET' && ['/', '/app.js', '/app.css'].includes(path)) {
        const file = path === '/' ? 'index.html' : path.slice(1);
        const bytes = await readFile(fileURLToPath(new URL(`./public/${file}`, import.meta.url)));
        res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(bytes); return;
      }
      if (req.method === 'GET' && path === '/api/config') {
        send(res, 200, { token, mode: opts.llm ? 'live' : 'extractive', provider: opts.llm?.provider, model: opts.llm?.model, statuses: STATUSES }); return;
      }
      if (req.headers['x-app-token'] !== token) throw new HttpError(403, 'Missing session token. Reload the page.');
      // Keep report/approval memory bounded; durable write outcomes remain in SQLite.
      for (const [id, t] of tasks) if (Date.now() - t.created > 30 * 60_000) tasks.delete(id);
      for (const [id, p] of previews) if (Date.now() - p.operation.expiresAt > 30 * 60_000) previews.delete(id);
      if (req.method === 'GET' && path === '/api/sample') {
        send(res, 200, { jd: await readFile(new URL('../../data/sample/jd-backend.txt', import.meta.url), 'utf8') }); return;
      }
      if (req.method === 'GET' && path === '/api/board') {
        send(res, 200, { applications: await readTool(opts.client, 'list_applications', {}) }); return;
      }
      if (req.method === 'POST' && path === '/api/analyse') {
        const input = z.object({ jd: z.string().trim().min(20).max(50_000) }).strict().parse(await body(req));
        if (activeAnalyses >= 2) throw new HttpError(429, 'Two analyses are already running. Please wait.');
        activeAnalyses++;
        try {
          const report = await analyseTask(opts.client, input.jd, { taskId, llm: opts.llm, tracer: opts.tracer, signal: controller.signal });
          if (tasks.size >= 100) tasks.delete(tasks.keys().next().value!);
          tasks.set(report.taskId, { report, created: Date.now() });
          send(res, 200, report); return;
        } finally { activeAnalyses--; }
      }
      if (req.method === 'POST' && path === '/api/preview') {
        const input = previewInput.parse(await body(req));
        let tool: string;
        let payload: Record<string, unknown>;
        if ('id' in input) { tool = 'update_application'; payload = input; }
        else {
          taskId = input.taskId;
          const task = tasks.get(taskId);
          if (!task) throw new HttpError(410, 'Report expired. Analyse the JD again.');
          tool = 'add_application';
          const { taskId: _, ...fields } = input;
          payload = { ...fields, notes: task.report.draft.rewrites.map(c => `${c.text} [${c.evidenceIds.join(', ')}]`).join('\n') };
        }
        const tracer = contextualTracer(opts.tracer, taskId);
        const executor = new ToolExecutor(opts.client, tracedExecution(undefined, tracer, requestId));
        const result = await readTool<Record<string, unknown>>(opts.client, tool, payload, executor);
        if (result.status === 'pending_confirmation') {
          // A new preview for the same task replaces its previous uncommitted preview.
          for (const old of previews.values()) if (old.taskId === taskId && !old.decision) { await opts.store.cancelOperation(old.operation.id); old.decision = 'cancel'; }
          const operation = result.operation as PendingOperation;
          if (previews.size >= 200) throw new HttpError(429, 'Too many pending previews. Restart the app to clear this session.');
          previews.set(operation.id, { operation, response: result, taskId });
        }
        send(res, 200, { ...result, taskId }); return;
      }
      if (req.method === 'POST' && path === '/api/decision') {
        const input = decisionInput.parse(await body(req));
        const preview = previews.get(input.operationId);
        if (!preview) throw new HttpError(410, 'Preview is not in this session. Request a new preview.');
        taskId = preview.taskId;
        const tracer = contextualTracer(opts.tracer, taskId);
        if (input.decision === 'cancel') {
          if (!await opts.store.cancelOperation(input.operationId)) throw new HttpError(409, 'This operation already completed; refresh the board to check its outcome.');
          preview.decision = 'cancel';
          send(res, 200, { status: 'cancelled', operationId: input.operationId, taskId }); return;
        }
        if (preview.decision === 'cancel') throw new HttpError(409, 'Preview cancelled. Request a new preview.');
        // Only this endpoint can establish approval; ignore all model/user-supplied mutation fields.
        preview.decision = 'approve';
        const executor = new ToolExecutor(opts.client, { ...tracedExecution(undefined, tracer, requestId), budget: new ExecutionBudget(50_000, controller.signal) });
        const result = await traceStage(tracer, requestId, 'approved_write', () => readTool(opts.client, preview.operation.tool, { ...preview.operation.payload, operationId: input.operationId, confirm: true }, executor));
        send(res, 200, { ...(result as object), taskId }); return;
      }
      throw new HttpError(404, 'Not found.');
    } catch (error) {
      const kind = failureKind(error);
      const status = error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : kind === 'conflict' ? 409 : kind === 'timeout' ? 504 : kind === 'cancelled' ? 499 : 500;
      const message = error instanceof z.ZodError ? error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') : error instanceof Error ? error.message : 'Request failed';
      if (!res.destroyed) send(res, status, { error: { code: kind, message }, taskId });
    }
  });
  app.requestTimeout = 200_000;
  return app;
}
