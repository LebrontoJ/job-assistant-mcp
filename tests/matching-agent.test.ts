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
