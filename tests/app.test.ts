import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/app/server.js';
import { connectedPair } from './helpers.js';
let app: ReturnType<typeof createApp>;
let appOptions: Parameters<typeof createApp>[0];
let pair: Awaited<ReturnType<typeof connectedPair>>;
let base: string, token: string;
const jd = readFileSync('data/sample/jd-backend.txt', 'utf8');
async function request(path: string, payload?: unknown, headers: Record<string,string> = {}) {
  const response = await fetch(base + path, { method: payload === undefined ? 'GET' : 'POST', headers: { 'X-App-Token': token, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: payload === undefined ? undefined : JSON.stringify(payload) });
  return { status: response.status, data: await response.json() as any };
}
beforeEach(async () => {
  pair = await connectedPair(); appOptions = { client: pair.client, store: pair.store }; app = createApp(appOptions);
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  const address = app.address(); base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  token = (await (await fetch(base + '/api/config')).json() as any).token;
});
afterEach(async () => { app.closeAllConnections(); await new Promise<void>(resolve => app.close(() => resolve())); await pair.client.close(); });
describe('local JD-to-board application', () => {
  it('runs analysis → evidence → preview → human approval → board, with idempotent resubmission', async () => {
    const before = await pair.store.list();
    const analysis = await request('/api/analyse', { jd });
    expect(analysis.status).toBe(200);
    expect(analysis.data.draft.rewrites.length).toBeGreaterThan(0);
    expect(analysis.data.validation.every((v: any) => v.supported)).toBe(true);
    expect(await pair.store.list()).toEqual(before);
    const preview = await request('/api/preview', { taskId: analysis.data.taskId, company: 'DemoCo', role: 'Backend', status: 'wishlist' });
    expect(preview.status).toBe(200);
    expect(preview.data.status).toBe('pending_confirmation');
    expect(await pair.store.list()).toEqual(before);
    const decision = { operationId: preview.data.operation.id, decision: 'approve' };
    const saved = await request('/api/decision', decision);
    expect(saved.data.status).toBe('created');
    expect((await request('/api/decision', decision)).data).toEqual(saved.data);
    const board = await request('/api/board');
    expect(board.data.applications).toHaveLength(before.length + 1);
    expect(board.data.applications.find((a: any) => a.company === 'DemoCo').notes).toMatch(/\.md#\d/);
  });
  it('runs model drafting and semantic verification through the same task API', async () => {
    let calls = 0;
    appOptions.llm = { provider: 'scripted-test', model: 'fixture', chat: async req => {
      calls++;
      const text = req.system.includes('verify factual entailment') ? JSON.stringify({ supported: true })
        : JSON.stringify({ rewrites: [{ text: 'Improved PostgreSQL performance through database indexing.', evidenceIds: ['resume.md#0'] }], suggestions: [] });
      return { text, toolCalls: [], finish: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
    } };
    const result = await request('/api/analyse', { jd });
    expect(result.status).toBe(200);
    expect(calls).toBe(2);
    expect(result.data.validation[0].reason).toBe('semantic_verification');
    expect(result.data.draft.rewrites).toHaveLength(1);
    expect(await pair.store.list()).toHaveLength(4);
  });
  it('cancels durably and refuses approval after cancellation', async () => {
    const analysis = await request('/api/analyse', { jd });
    const preview = await request('/api/preview', { taskId: analysis.data.taskId, company: 'CancelledCo', role: 'SWE', status: 'wishlist' });
    const operationId = preview.data.operation.id;
    expect((await request('/api/decision', { operationId, decision: 'cancel' })).data.status).toBe('cancelled');
    expect((await request('/api/decision', { operationId, decision: 'approve' })).status).toBe(409);
    expect(await pair.store.list({ company: 'CancelledCo' })).toHaveLength(0);
  });
  it('previews stage changes and rejects an application changed after preview', async () => {
    const app = (await pair.store.list())[0]!;
    const preview = await request('/api/preview', { id: app.id, status: 'interview' });
    expect(preview.data.current.status).toBe(app.status);
    await pair.store.update(app.id, { notes: 'a concurrent change' });
    const result = await request('/api/decision', { operationId: preview.data.operation.id, decision: 'approve' });
    expect(result.status).toBe(409);
    expect(result.data.error.message).toContain('VERSION_CONFLICT');
    expect((await pair.store.get(app.id))?.status).toBe(app.status);
    expect((await request('/api/decision', { operationId: preview.data.operation.id, decision: 'cancel' })).data.status).toBe('cancelled');
  });
  it('applies a board stage change only after confirmation', async () => {
    const row = (await pair.store.list())[0]!;
    const preview = await request('/api/preview', { id: row.id, status: 'oa' });
    expect((await pair.store.get(row.id))?.status).toBe(row.status);
    const result = await request('/api/decision', { operationId: preview.data.operation.id, decision: 'approve' });
    expect(result.data.status).toBe('updated');
    expect((await pair.store.get(row.id))?.status).toBe('oa');
    expect((await pair.store.get(row.id))?.version).toBe(row.version + 1);
  });
  it('rejects missing tokens, foreign origins, forged decisions and invalid dates', async () => {
    expect((await request('/api/board', undefined, { 'X-App-Token': '' })).status).toBe(403);
    expect((await request('/api/board', undefined, { Origin: 'https://attacker.test' })).status).toBe(403);
    expect((await request('/api/decision', { operationId: crypto.randomUUID(), decision: 'approve' })).status).toBe(410);
    expect((await request('/api/decision', { operationId: crypto.randomUUID(), decision: 'approve', confirm: true })).status).toBe(400);
    expect((await request('/api/preview', { taskId: crypto.randomUUID(), company: 'X', role: 'Y', status: 'wishlist', nextFollowUp: '2026-02-30' })).status).toBe(400);
  });
  it('serves a local UI with CSP and explicitly labelled extractive mode', async () => {
    const response = await fetch(base);
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await response.text()).toContain('投递看板');
    expect((await (await fetch(base + '/api/config')).json() as any).mode).toBe('extractive');
    expect((await fetch(base + '/.env')).status).toBe(403);
  });
});
