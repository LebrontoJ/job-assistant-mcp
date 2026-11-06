import { describe, expect, it } from 'vitest';
import { collectEvidence, addSources } from '../src/matching/evidence.js';
import { runMatching } from '../src/matching/agent.js';
import { MatchCache } from '../src/matching/cache.js';
import { validateAssessment } from '../src/matching/assessor.js';
import type { LLMClient, ChatRequest, ChatResponse } from '../src/agent/llm/types.js';
import { connectedPair, textOf } from './helpers.js';
const response = (text: string, toolCalls: ChatResponse['toolCalls'] = []): ChatResponse => ({ text, toolCalls, finish: toolCalls.length ? 'tool_calls' : 'stop', usage: { inputTokens: 1, outputTokens: 1 } });
const judgment = (req: ChatRequest) => {
  const input = JSON.parse((req.messages[0] as { text: string }).text);
  return response(JSON.stringify({ items: input.requirements.map((r: any) => ({ requirementId: r.id, criteria: r.criteria.map((c: any) => ({ criterionId: c.id, verdict: input.sources.length ? 'supported' : 'insufficient', evidence: input.sources.length ? [{ sourceId: input.sources[0].id, quote: input.sources[0].text.split('\n')[0] }] : [], reason: 'Fixture decision', missingInformation: input.sources.length ? [] : ['Candidate evidence'] })) })) }));
};
const emptyBundle = () => collectEvidence({ requirements: ['Python services'], niceToHave: [] }, async () => []);
describe('PR review regressions', () => {
  it('consumes real MCP search results during supplementary search', async () => {
    const { client } = await connectedPair();
    try {
      const bundle = await emptyBundle();
      const llm: LLMClient = { provider: 'test', model: 'real-mcp-shape', chat: async req => req.tools.length ? response('', [{ id: 's', name: 'search_profile', args: { requirementId: bundle.packets[0]!.requirement.id, query: 'Python services' } }]) : judgment(req) };
      const result = await runMatching(bundle, { mode: 'agent', llm, search: async (query, k) => JSON.parse(textOf(await client.callTool({ name: 'search_profile', arguments: { query, k } }))).hits });
      expect(result.items[0]?.verdict).toBe('supported');
      expect(result.sources.length).toBeGreaterThan(0);
    } finally { await client.close(); }
  });
  it('uses only source fields for identity when retrieval scores differ', async () => {
    const hit = { id: 'p', source: 'p.md', heading: 'Work', text: 'Python services.' };
    const bundle = await collectEvidence({ requirements: ['Python services'], niceToHave: [] }, async () => [hit]);
    const scored = { ...hit, score: 1.2, keywordCoverage: 0.8 };
    expect(() => addSources(bundle, bundle.packets[0]!.requirement.id, [scored])).not.toThrow();
    expect(bundle.sources).toHaveLength(1);
  });
  it('does not cache failed planning as a completed matching run', async () => {
    const bundle = await emptyBundle(); const cache = new MatchCache(); let calls = 0, failed = false;
    const llm: LLMClient = { provider: 'test', model: 'recover', chat: async req => {
      calls++;
      if (req.tools.length) { if (!failed) { failed = true; throw new Error('ECONNRESET'); } return response('No useful query remains.'); }
      return judgment(req);
    } };
    const opts = { mode: 'agent' as const, llm, cache, search: async () => [] };
    await runMatching(bundle, opts);
    const retry = await runMatching(bundle, opts);
    expect(retry.meta.cacheHit).toBe(false);
    expect(calls).toBe(4);
  });
  it('does not cache a failed supplementary read as no-new-evidence', async () => {
    const bundle = await emptyBundle(); const cache = new MatchCache(); let reads = 0;
    const llm: LLMClient = { provider: 'test', model: 'read-recovery', chat: async req => req.tools.length ? response('', [{ id: 's', name: 'search_profile', args: { requirementId: bundle.packets[0]!.requirement.id, query: 'Python services' } }]) : judgment(req) };
    const opts = { mode: 'agent' as const, llm, cache, search: async () => { if (++reads === 1) throw new Error('ECONNRESET'); return [{ id: 'p', source: '', heading: '', text: 'Python services.' }]; } };
    const first = await runMatching(bundle, opts);
    expect(first.meta.stoppedBecause).not.toBe('no_new_evidence');
    expect((await runMatching(bundle, opts)).items[0]?.verdict).toBe('supported');
    expect(reads).toBe(2);
  });
  it('preserves planner timeout instead of relabelling completed initial judgments as successful execution', async () => {
    const bundle = await emptyBundle();
    const llm: LLMClient = { provider: 'test', model: 'planner-timeout', chat: async req => req.tools.length ? new Promise(() => {}) : judgment(req) };
    const result = await runMatching(bundle, { mode: 'agent', llm, search: async () => [], callMs: 20, totalMs: 500 });
    expect(result.items[0]?.assessmentStatus).toBe('assessed');
    expect(result.meta.stoppedBecause).toBe('timeout');
  });
  it('caps spelled-out English durations but permits independently supported non-duration counts', async () => {
    for (const [requirement, expected] of [['Five years of backend experience', 'partial'], ['Several months of Python development', 'partial'], ['半年相关开发经验', 'partial'], ['A half-year backend project', 'partial'], ['At least 3 delivered projects', 'supported']]) {
      const bundle = await collectEvidence({ requirements: [requirement!], niceToHave: [] }, async () => [{ id: 'p', source: '', heading: '', text: requirement! }]);
      const r = bundle.packets[0]!.requirement;
      const value = { items: [{ requirementId: r.id, criteria: [{ criterionId: r.criteria[0]!.id, verdict: 'supported', evidence: [{ sourceId: 'p', quote: requirement }], reason: 'Literal evidence', missingInformation: [] }] }] };
      expect(validateAssessment(value, bundle, [r]).items[0]?.verdict).toBe(expected);
    }
  });
});

import { evaluateMatchingCase, summarizeMatching } from '../evals/resume-matching.js';
import { createMatching } from '../src/matching/factory.js';
it('keeps a failed planner in operational errors even when the initial judgment was completed', async () => {
  const c = { id: 'planner-outage', split: 'dev' as const, category: 'failure', requirement: 'Python services', profile: { 'p.md': 'Unrelated documentation.' }, expectedVerdict: 'insufficient' as const, goldEvidence: [] };
  const llm: LLMClient = { provider: 'test', model: 'planner-down', chat: async req => { if (req.tools.length) throw new Error('ECONNRESET'); return judgment(req); } };
  const row = await evaluateMatchingCase(c, 'agent', { llm });
  expect(row.judgmentCompleted).toBe(true);
  expect(row.completed).toBe(false);
  expect(row.error).toBeDefined();
  expect(summarizeMatching([row])).toMatchObject({ errors: 1, completion: { numerator: 0 }, judgmentCompletion: { numerator: 1 } });
});
it('keeps matching runtime settings injectable for the live comparison', () => {
  const opts = createMatching({ GEMINI_API_KEY: 'synthetic-test-key', MATCH_MODE: 'assessment', MATCH_TOTAL_MS: '250', MATCH_CALL_MS: '100', MATCH_MAX_ROUNDS: '1', MATCH_MAX_SEARCHES: '2', MATCH_CACHE: 'off' });
  expect(opts).toMatchObject({ totalMs: 250, callMs: 100, maxRounds: 1, maxSearches: 2 });
  expect(opts.cache).toBeUndefined();
});
