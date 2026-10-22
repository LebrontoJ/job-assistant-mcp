import { describe, it, expect, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ExecutionBudget, ExecutionError, ToolExecutor, type ToolAttempt } from '../src/agent/execution.js';
import { connectedPair, textOf } from './helpers.js';
const ok = { content: [{ type: 'text', text: '{}' }] };
const fake = (callTool: (...args: any[]) => Promise<any>) => ({ callTool }) as Client;
describe('bounded tool execution', () => {
  it('retries a transient read and records each attempt', async () => {
    const calls = vi.fn().mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValue(ok);
    const events: ToolAttempt[] = [];
    await new ToolExecutor(fake(calls), { retryDelayMs: 1, onAttempt: e => events.push(e) }).call('search_profile', { query: 'postgres' });
    expect(calls).toHaveBeenCalledTimes(2);
    expect(events.map(e => [e.attempt, e.retrying])).toEqual([[1,true],[2,false]]);
  });
  it('times out and cancels hanging tools within the total budget', async () => {
    let aborted = 0;
    const calls = vi.fn((_params, _schema, opts) => new Promise(() => opts.signal.addEventListener('abort', () => aborted++)));
    await expect(new ToolExecutor(fake(calls), { budget: new ExecutionBudget(35), timeoutMs: 10, retryDelayMs: 1, maxAttempts: 2 }).call('list_applications', {})).rejects.toMatchObject({ kind: 'timeout' });
    expect(calls).toHaveBeenCalledTimes(2);
    expect(aborted).toBe(2);
  });
  it('does not retry invalid requests, conflicts or unkeyed writes', async () => {
    for (const [name, args, message] of [
      ['search_profile', {}, 'invalid parameters'],
      ['update_application', { confirm: true, operationId: 'op' }, 'VERSION_CONFLICT'],
      ['add_application', { confirm: true }, 'ECONNRESET'],
    ] as const) {
      const calls = vi.fn().mockRejectedValue(new Error(message));
      await expect(new ToolExecutor(fake(calls), { retryDelayMs: 1 }).call(name, args)).rejects.toThrow(message);
      expect(calls).toHaveBeenCalledTimes(1);
    }
  });
  it('recovers a lost response after a committed write without duplicating it', async () => {
    const { client, store } = await connectedPair();
    try {
      const args = { company: 'Recovery', role: 'SWE' };
      const preview = JSON.parse(textOf(await client.callTool({ name: 'add_application', arguments: args })));
      let first = true;
      const flaky = fake(async (...params) => {
        const out = await client.callTool(params[0], params[1], params[2]);
        if (first) { first = false; throw new ExecutionError('timeout', 'response lost after commit'); }
        return out;
      });
      const result = await new ToolExecutor(flaky, { retryDelayMs: 1 }).call('add_application', { ...args, confirm: true, operationId: preview.operation.id });
      expect(JSON.parse(textOf(result)).status).toBe('created');
      expect(await store.list({ company: 'Recovery' })).toHaveLength(1);
    } finally { await client.close(); }
  });
  it('honours explicit user cancellation', async () => {
    const controller = new AbortController(); controller.abort();
    const calls = vi.fn();
    await expect(new ToolExecutor(fake(calls), { budget: new ExecutionBudget(100, controller.signal) }).call('list_applications', {})).rejects.toMatchObject({ kind: 'cancelled' });
    expect(calls).not.toHaveBeenCalled();
  });
});
