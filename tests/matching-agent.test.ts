import { describe, it, expect } from 'vitest';
import { collectEvidence } from '../src/matching/evidence.js';
import { runMatching } from '../src/matching/agent.js';
import type { LLMClient, ChatRequest, ChatResponse } from '../src/agent/llm/types.js';
const reply = (text: string, toolCalls: ChatResponse['toolCalls'] = []): ChatResponse => ({ text, toolCalls, finish: toolCalls.length ? 'tool_calls' : 'stop', usage: { inputTokens: 2, outputTokens: 1 } });
function assessment(req: ChatRequest, supported = false) {
  const input = JSON.parse((req.messages[0] as { text: string }).text);
  return reply(JSON.stringify({ items: input.requirements.map((r: any) => ({ requirementId: r.id, criteria: r.criteria.map((c: any) => ({ criterionId: c.id, verdict: supported ? 'supported' : 'insufficient', evidence: supported ? [{ sourceId: 'p', quote: 'Built Python services.' }] : [], reason: supported ? 'Direct evidence' : 'No evidence', missingInformation: supported ? [] : ['Python work'] })) })) }));
}
describe('bounded read-only matching agent', () => {
  it('finds initially missed evidence and reassesses only after a real read', async () => {
    const bundle = await collectEvidence({ requirements: ['Built Python services'], niceToHave: [] }, async () => []);
    let seen = false, reads = 0;
    const llm: LLMClient = { provider: 'test', model: 'test', chat: async req => {
      if (req.tools.length) return reply('', [{ id: 's', name: 'search_profile', args: { requirementId: bundle.packets[0]!.requirement.id, query: 'Python services' } }]);
      return assessment(req, seen);
    } };
    const result = await runMatching(bundle, { mode: 'agent', llm, search: async () => { reads++; seen = true; return [{ id: 'p', source: '', heading: '', text: 'Built Python services.' }]; } });
    expect(result.items[0]?.verdict).toBe('supported');
    expect(result.meta).toMatchObject({ searches: 1, rounds: 1, modelCalls: 3, inputTokens: 6 });
    expect(reads).toBe(1);
    expect(bundle.sources).toEqual([]);
  });
  it('never executes writes, recursive matching, unknown requirements or duplicate queries', async () => {
    const bundle = await collectEvidence({ requirements: ['Python'], niceToHave: [] }, async () => []);
    let reads = 0;
    const args = { requirementId: bundle.packets[0]!.requirement.id, query: 'Python' };
    const llm: LLMClient = { provider: 'test', model: 'test', chat: async req => req.tools.length ? reply('', [
      { id: 'w', name: 'add_application', args: {} }, { id: 'r', name: 'match_resume', args: {} },
      { id: 'u', name: 'search_profile', args: { ...args, requirementId: 'unknown' } },
      { id: 's', name: 'search_profile', args }, { id: 'd', name: 'search_profile', args },
    ]) : assessment(req) };
    const result = await runMatching(bundle, { mode: 'agent', llm, search: async () => { reads++; return []; } });
    expect(reads).toBe(1);
    expect(result.meta.stoppedBecause).toBe('no_new_evidence');
    expect(result.items[0]?.verdict).toBe('insufficient');
  });
  it('leaves retrieval-only results explicitly unassessed without model calls', async () => {
    const bundle = await collectEvidence({ requirements: ['Python'], niceToHave: [] }, async () => []);
    const result = await runMatching(bundle);
    expect(result.items[0]).toMatchObject({ verdict: null, assessmentStatus: 'unassessed' });
    expect(result.meta.modelCalls).toBe(0);
  });
});

import { MatchCache } from '../src/matching/cache.js';
import { ExecutionBudget } from '../src/agent/execution.js';
import { MemoryTracer } from '../src/agent/trace.js';
describe('matching recovery, cancellation and accounting', () => {
  it('returns timed-out judgments without hanging and aborts the provider request', async () => {
    const bundle = await collectEvidence({ requirements: ['Python'], niceToHave: [] }, async () => []);
    let signal: AbortSignal | undefined;
    const llm: LLMClient = { provider: 'test', model: 'hang', chat: async req => { signal = req.signal; return new Promise(() => {}); } };
    const result = await runMatching(bundle, { mode: 'assessment', llm, totalMs: 50 });
    expect(result.items[0]).toMatchObject({ assessmentStatus: 'timeout', verdict: null });
    expect(result.meta.stoppedBecause).toBe('timeout');
    expect(signal?.aborted).toBe(true);
  });
  it('propagates user cancellation rather than returning a fallback report', async () => {
    const bundle = await collectEvidence({ requirements: ['Python'], niceToHave: [] }, async () => []);
    const controller = new AbortController();
    const llm: LLMClient = { provider: 'test', model: 'cancel', chat: async () => { controller.abort(); return new Promise(() => {}); } };
    await expect(runMatching(bundle, { mode: 'assessment', llm, signal: controller.signal })).rejects.toThrow(/cancel/i);
  });
  it('keeps completed batches when a later batch fails', async () => {
    const bundle = await collectEvidence({ requirements: ['Python', 'Go'], niceToHave: [] }, async () => []);
    let calls = 0;
    const llm: LLMClient = { provider: 'test', model: 'partial', chat: async req => { if (++calls === 2) throw new Error('provider unavailable'); return assessment(req); } };
    const result = await runMatching(bundle, { mode: 'assessment', llm, batchSize: 1 });
    expect(result.items.map(i => i.assessmentStatus)).toEqual(['assessed', 'failed']);
    expect(result.summary.requirement).toMatchObject({ assessed: 1, unassessed: 1 });
  });
  it('caps supplementary reads at six even when the model requests more', async () => {
    const bundle = await collectEvidence({ requirements: ['Python'], niceToHave: [] }, async () => []);
    let reads = 0;
    const llm: LLMClient = { provider: 'test', model: 'greedy', chat: async req => req.tools.length ? reply('', Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, name: 'search_profile', args: { requirementId: bundle.packets[0]!.requirement.id, query: `Python ${i}` } }))) : assessment(req) };
    const result = await runMatching(bundle, { mode: 'agent', llm, search: async () => [{ id: `p${++reads}`, source: '', heading: '', text: 'Related services.' }] });
    expect(reads).toBe(6); expect(result.meta.searches).toBe(6);
    expect(result.meta.stoppedBecause).toBe('search_limit');
  });
  it('replays complete results at zero usage and invalidates by corpus and model', async () => {
    const bundle = await collectEvidence({ requirements: ['Python'], niceToHave: [] }, async () => [], {}, 'corpus-a');
    const cache = new MatchCache(); let calls = 0;
    const tracer = new MemoryTracer();
    const llm: LLMClient = { provider: 'test', model: 'cached', chat: async req => { calls++; return assessment(req); } };
    const first = await runMatching(bundle, { mode: 'assessment', llm, cache, tracer });
    const replay = await runMatching(bundle, { mode: 'assessment', llm, cache });
    expect(replay.meta).toMatchObject({ cacheHit: true, modelCalls: 0, inputTokens: 0, searches: 0 });
    expect(first.meta.modelCalls).toBe(1); expect(calls).toBe(1);
    expect(tracer.events.some(e => e.type === 'match_assessment' && e.requirementId === bundle.packets[0]!.requirement.id)).toBe(true);
    await runMatching({ ...bundle, snapshotHash: 'changed' }, { mode: 'assessment', llm, cache });
    await runMatching(bundle, { mode: 'assessment', llm: { ...llm, model: 'another' }, cache });
    expect(calls).toBe(3);
  });
  it('reserves time for later phases and inherits abort signals', async () => {
    const controller = new AbortController();
    const parent = new ExecutionBudget(1000, controller.signal);
    const child = parent.child(900, 400);
    expect(child.remaining()).toBeLessThanOrEqual(600);
    expect(() => parent.child(900, 2000)).toThrow('No budget');
    controller.abort();
    expect(() => child.assertActive()).toThrow('cancelled');
  });
});
