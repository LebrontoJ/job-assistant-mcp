import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { JsonlTracer, MemoryTracer, contextualTracer, traceStage } from '../src/agent/trace.js';
import { analyseTask } from '../src/agent/task.js';
import { runAgent } from '../src/agent/loop.js';
import { connectedPair } from './helpers.js';
describe('correlation and privacy', () => {
  it('redacts content while keeping correlation and failure metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ja-redact-'));
    try {
      const file = join(dir, 'trace.jsonl');
      const tracer = contextualTracer(new JsonlTracer(file), 'task1');
      tracer?.emit({ type: 'tool_call', runId: 'r', ts: new Date().toISOString(), toolCallId: 'call1', operationId: 'op1', step: 1, name: 'add_application', args: 'private email@example.com', result: 'secret profile', isError: false, ms: 4 });
      await expect(traceStage(tracer, 'r', 'mcp.connect', async () => { throw new Error('ECONNRESET secret'); })).rejects.toThrow();
      const text = await readFile(file, 'utf8');
      expect(text).not.toMatch(/secret|email@example.com/);
      expect(text).toContain('task1'); expect(text).toContain('call1'); expect(text).toContain('op1'); expect(text).toContain('transient');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('records tools/list failures and still closes the run', async () => {
    const { client } = await connectedPair();
    const memory = new MemoryTracer();
    try {
      await client.close();
      await expect(runAgent({ provider: 'fake', model: 'fake', chat: async () => { throw new Error('must not run'); } }, client, 'hello', { tracer: memory, taskId: 'task1' })).rejects.toThrow();
      expect(memory.events.find(e => e.type === 'stage' && e.name === 'tools/list')).toMatchObject({ status: 'error', taskId: 'task1' });
      expect(memory.events.at(-1)).toMatchObject({ type: 'run_end', stoppedBecause: 'error' });
    } finally { await client.close(); }
  });
  it('correlates every structured task call to one task id', async () => {
    const { client } = await connectedPair();
    const memory = new MemoryTracer();
    try {
      await analyseTask(client, 'Backend engineer. Requirements:\n- Python services\n- PostgreSQL', { tracer: memory, taskId: 'task1' });
      expect(memory.events.length).toBeGreaterThan(3);
      expect(memory.events.every(e => e.taskId === 'task1')).toBe(true);
      expect(memory.events.filter(e => e.type === 'tool_attempt').every(e => e.toolCallId && e.attempt === 1)).toBe(true);
      expect(memory.events.at(-1)).toMatchObject({ stoppedBecause: 'answered' });
    } finally { await client.close(); }
  });
});
