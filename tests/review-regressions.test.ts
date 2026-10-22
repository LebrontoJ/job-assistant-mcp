import { describe, it, expect, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { validateClaim, answerGroundingProblem } from '../src/agent/grounding.js';
import { runAgent } from '../src/agent/loop.js';
import { analyseTask } from '../src/agent/task.js';
import { ProfileIndex } from '../src/rag/index.js';
import { MemoryTracer, summarizeEvents } from '../src/agent/trace.js';
import { formatReport, stability } from '../evals/report.js';
import type { CaseResult } from '../evals/runner.js';
import type { LLMClient, Message } from '../src/agent/llm/types.js';
import { connectedPair, textOf } from './helpers.js';
const evidence = { id: '简历 文件.md#0', source: '简历 文件.md', heading: '', text: 'Reduced release time from 40 to 12 minutes.' };
const reply = (text: string) => ({ text, toolCalls: [], finish: 'stop' as const, usage: { inputTokens: 0, outputTokens: 0 } });
const llm = (text: string): LLMClient => ({ provider: 'test', model: 'test', chat: async () => reply(text) });
const history: Message[] = [{ role: 'tool', results: [{ name: 'search_profile', callId: 'r', text: JSON.stringify({ hits: [evidence] }) }] }];
const client = { listTools: async () => ({ tools: [] }) } as unknown as Client;
describe('review regressions', () => {
  it('rejects reversed quantities even with an optimistic semantic verifier', async () => {
    const verify = vi.fn(async () => true);
    expect((await validateClaim({ text: 'Reduced release time from 12 to 40 minutes.', evidenceIds: [evidence.id] }, [evidence], verify)).supported).toBe(false);
    expect(verify).not.toHaveBeenCalled();
  });
  it('does not accept reversed actor/object relationships as local paraphrases', async () => {
    const source = { ...evidence, text: 'Python service calls Go worker.' };
    expect((await validateClaim({ text: 'Go worker calls Python service.', evidenceIds: [source.id] }, [source])).supported).toBe(false);
  });
  it('blocks unsupported experience for ordinary questions but allows greetings and tracker responses', async () => {
    const run = await runAgent(llm('You have 8 years of Kubernetes experience.'), client, 'How long have I worked with Kubernetes?');
    expect(run.stoppedBecause).toBe('blocked');
    expect(await answerGroundingProblem('Hello!', 'hello', [])).toBeUndefined();
    expect(await answerGroundingProblem('You have 3 applications.', 'Show my applications', [])).toBeUndefined();
  });
  it('accepts exact evidence with Unicode and spaced filenames through the whole agent', async () => {
    const run = await runAgent(llm(`${evidence.text} [${evidence.id}]`), client, 'Rewrite my resume', { history });
    expect(run.stoppedBecause).toBe('answered');
  });
  it('times out semantic verification and propagates cancellation', async () => {
    let signal: AbortSignal | undefined;
    await expect(runAgent(llm(`Accelerated releases. [${evidence.id}]`), client, 'Rewrite my resume', {
      history, totalMs: 40, groundingVerifier: async (_claim, _sources, abort) => { signal = abort; return new Promise(() => {}); },
    })).rejects.toThrow(/timed out|budget/);
    expect(signal?.aborted).toBe(true);
  });
  it('verifies a successful paraphrase only once', async () => {
    const verify = vi.fn(async () => true);
    const run = await runAgent(llm(`Accelerated releases. [${evidence.id}]`), client, 'Rewrite my resume', { history, groundingVerifier: verify });
    expect(run.stoppedBecause).toBe('answered');
    expect(verify).toHaveBeenCalledTimes(1);
  });
  it('binds the displayed snapshot and operation to the same version and rejects later changes', async () => {
    const pair = await connectedPair();
    try {
      const app = await pair.store.add({ company: 'Review', role: 'Engineer' });
      // If a separate pre-read is reintroduced, force a write between that read and prepare.
      const get = pair.store.get.bind(pair.store);
      vi.spyOn(pair.store, 'get').mockImplementation(async id => { const old = await get(id); await pair.store.update(id, { status: 'rejected' }); return old; });
      const preview = JSON.parse(textOf(await pair.client.callTool({ name: 'update_application', arguments: { id: app.id, status: 'applied' } })));
      expect(preview.current.version).toBe(preview.operation.expectedVersion);
      await pair.store.update(app.id, { status: 'interview' });
      const out = await pair.client.callTool({ name: 'update_application', arguments: { id: app.id, status: 'applied', confirm: true, operationId: preview.operation.id } });
      expect(out.isError).toBe(true);
      expect(textOf(out)).toContain('VERSION_CONFLICT');
    } finally { await pair.client.close(); }
  });
  it('recovers document embeddings after a failed first build', async () => {
    let calls = 0;
    const index = ProfileIndex.fromMarkdown({ 'r.md': '# Skills\nGo services' }, { embed: async (texts, kind) => {
      if (kind === 'document' && ++calls === 1) throw new Error('temporary outage');
      return texts.map(() => [1, 0]);
    } });
    await expect(index.search('Go')).rejects.toThrow('temporary outage');
    expect(await index.search('Go')).toHaveLength(1);
    expect(calls).toBe(2);
  });
  it('keeps multiline-sentence extracts validated and counts structured tool calls', async () => {
    const tracer = new MemoryTracer();
    const source = { ...evidence, text: 'Reduced latency 38%. Built Go services.' };
    const fake = { callTool: async ({ name }: { name: string }) => ({ content: [{ type: 'text', text: JSON.stringify(name === 'parse_jd'
      ? { requirements: ['Go services'], niceToHave: [], skills: ['Go'] }
      : name === 'match_resume' ? { items: [], summary: { skillsMissing: [] } } : { hits: [source] }) }] }) } as unknown as Client;
    const task = await analyseTask(fake, 'Engineer with Go services', { tracer });
    expect(task.draft.rewrites).toHaveLength(1);
    expect(task.validation.every(v => v.supported)).toBe(true);
    expect(summarizeEvents(tracer.events).tools.reduce((n, t) => n + t.calls, 0)).toBe(4);
  });
  it('reports verdict rates separately from completion and excludes outages from stability', () => {
    const base: CaseResult = { id: 'c', category: 'faithfulness', suite: 'core', passed: true, checks: [], tools: [], answer: '', steps: 1, usage: { inputTokens: 0, outputTokens: 0 }, ms: 1, blocked: 0, citationRetries: 0 };
    const ungraded = { ...base, passed: false, ungraded: true, checks: [{ type: 'judge' as const, dimension: 'faithfulness' as const, pass: false, graderError: true, detail: 'unavailable' }] };
    const outage = { ...base, passed: false, error: 'API outage' };
    const report = formatReport({ provider: 'p', model: 'm', date: 'today' }, [base, ungraded, outage]);
    expect(report).toContain('1/1 (100%)');
    expect(report).toContain('Overall completion: 2/3');
    expect(report).toContain('| faithfulness | 0/0 | n/a');
    expect(stability([[outage]]).alwaysFail).toEqual([]);
  });
  it('combines retry attempts without duplicating an Agent tool_call', () => {
    const tracer = new MemoryTracer();
    const common = { runId: 'r', ts: new Date().toISOString(), toolCallId: 'c', name: 'search_profile' };
    tracer.emit({ ...common, type: 'tool_attempt', attempt: 1, ms: 5, errorKind: 'transient', retrying: true });
    tracer.emit({ ...common, type: 'tool_attempt', attempt: 2, ms: 7, retrying: false });
    expect(summarizeEvents(tracer.events).tools[0]).toMatchObject({ calls: 1, errors: 0, avgMs: 12 });
    tracer.emit({ ...common, type: 'tool_call', step: 1, args: '', result: '', isError: false, ms: 20 });
    expect(summarizeEvents(tracer.events).tools[0]).toMatchObject({ calls: 1, errors: 0, avgMs: 20 });
  });
});
