import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { LLMClient } from './llm/types.js';

export type FailureKind = 'timeout' | 'cancelled' | 'transient' | 'invalid' | 'conflict' | 'permanent';
export class ExecutionError extends Error {
  constructor(readonly kind: FailureKind, message: string) { super(message); this.name = 'ExecutionError'; }
}
export function failureKind(error: unknown): FailureKind {
  if (error instanceof ExecutionError) return error.kind;
  const text = String(error);
  if (/VERSION_CONFLICT|PAYLOAD_CHANGED|APPROVAL_|PREVIEW_REQUIRED|DUPLICATE/i.test(text)) return 'conflict';
  if (/timeout|timed out|ETIMEDOUT/i.test(text) || (error as {code?: number})?.code === -32001) return 'timeout';
  if (/abort|cancelled/i.test(text)) return 'cancelled';
  if (/ECONNRESET|ECONNREFUSED|EPIPE|fetch failed|temporar|SQLITE_BUSY|database is locked|\b429\b|\b50[0234]\b/i.test(text)) return 'transient';
  if (/invalid|validation|not found|unknown tool|APPLICATION_NOT_FOUND/i.test(text)) return 'invalid';
  return 'permanent';
}
export class ExecutionBudget {
  private readonly deadline: number;
  constructor(totalMs = 180_000, private readonly signal?: AbortSignal) {
    if (!(totalMs > 0)) throw new Error('totalMs must be positive');
    this.deadline = Date.now() + totalMs;
  }
  remaining(): number { return Math.max(0, this.deadline - Date.now()); }
  async run<T>(label: string, timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.signal?.aborted) throw new ExecutionError('cancelled', `${label}: cancelled`);
    const ms = Math.min(timeoutMs, this.remaining());
    if (ms <= 0) throw new ExecutionError('timeout', `${label}: task budget exhausted`);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let interruption: ExecutionError | undefined;
    let rejectAbort: (reason: unknown) => void = () => {};
    const abort = () => { interruption = new ExecutionError('cancelled', `${label}: cancelled`); controller.abort(interruption); rejectAbort(interruption); };
    const interrupted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
      timer = setTimeout(() => { interruption = new ExecutionError('timeout', `${label}: timed out after ${ms}ms`); controller.abort(interruption); reject(interruption); }, ms);
      this.signal?.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([Promise.resolve().then(() => fn(controller.signal)), interrupted]); }
    catch (error) { throw interruption ?? error; }
    finally { clearTimeout(timer); this.signal?.removeEventListener('abort', abort); }
  }
}
export interface ToolAttempt {
  toolCallId: string; name: string; operationId?: string; attempt: number; ms: number; errorKind?: FailureKind; retrying: boolean;
}
export interface ExecutionOptions {
  budget?: ExecutionBudget; timeoutMs?: number; maxAttempts?: number; retryDelayMs?: number;
  onAttempt?: (event: ToolAttempt) => void;
}
const READ_TOOLS = new Set(['parse_jd', 'match_resume', 'search_profile', 'list_applications', 'list_followups']);
export class ToolExecutor {
  private readonly budget: ExecutionBudget;
  constructor(private readonly client: Client, private readonly opts: ExecutionOptions = {}) { this.budget = opts.budget ?? new ExecutionBudget(); }
  async call(name: string, args: Record<string, unknown>, toolCallId: string = randomUUID()): Promise<Awaited<ReturnType<Client['callTool']>>> {
    const safe = READ_TOOLS.has(name) || (['add_application', 'update_application'].includes(name) && args.confirm === true && typeof args.operationId === 'string');
    const attempts = safe ? Math.max(1, this.opts.maxAttempts ?? 3) : 1;
    for (let attempt = 1; ; attempt++) {
      const start = Date.now();
      try {
        const out = await this.budget.run(name, this.opts.timeoutMs ?? 15_000, signal => this.client.callTool({ name, arguments: args }, undefined, { signal, timeout: this.opts.timeoutMs ?? 15_000 }));
        if (out.isError) {
          const text = JSON.stringify(out.content);
          const kind = failureKind(text);
          if (kind === 'transient' || kind === 'timeout') throw new ExecutionError(kind, `${name}: ${text}`);
          this.opts.onAttempt?.({ toolCallId, name, operationId: args.operationId as string | undefined, attempt, ms: Date.now() - start, errorKind: kind, retrying: false });
        } else this.opts.onAttempt?.({ toolCallId, name, operationId: args.operationId as string | undefined, attempt, ms: Date.now() - start, retrying: false });
        return out;
      } catch (error) {
        const kind = failureKind(error);
        const retrying = attempt < attempts && ['timeout', 'transient'].includes(kind) && this.budget.remaining() > (this.opts.retryDelayMs ?? 100) * attempt;
        this.opts.onAttempt?.({ toolCallId, name, operationId: args.operationId as string | undefined, attempt, ms: Date.now() - start, errorKind: kind, retrying });
        if (!retrying) throw error;
        await this.budget.run(`${name}: retry wait`, this.budget.remaining(), signal => new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(new ExecutionError('cancelled', 'retry cancelled')); };
          const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, (this.opts.retryDelayMs ?? 100) * attempt);
          signal.addEventListener('abort', abort, { once: true });
        }));
      }
    }
  }
}
export function boundedLLM(llm: LLMClient, budget: ExecutionBudget, timeoutMs = 60_000): LLMClient {
  return { provider: llm.provider, model: llm.model, chat: req => budget.run('model', timeoutMs, signal => llm.chat({ ...req, signal })) };
}
