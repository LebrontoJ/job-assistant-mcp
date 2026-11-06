import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { evaluateMatchingCase, loadMatchingCases, summarizeMatching } from '../evals/resume-matching.js';
import type { LLMClient } from '../src/agent/llm/types.js';
describe('matching comparison protocol', () => {
  it('pins synthetic dev and acceptance fixtures without scoring the acceptance split during development', async () => {
    const manifest = JSON.parse(await readFile('evals/matching/manifest.json', 'utf8'));
    for (const [file, hash] of Object.entries(manifest.files)) expect(createHash('sha256').update(await readFile(`evals/matching/${file}`)).digest('hex')).toBe(hash);
    const cases = await loadMatchingCases();
    expect(cases).toHaveLength(40);
    expect(new Set(cases.map(c => c.expectedVerdict)).size).toBe(4);
    expect(cases.some(c => c.category === 'injection')).toBe(true);
  });
  it('compares baseline label projection to a scripted assessor without treating it as live quality', async () => {
    const c = (await loadMatchingCases()).find(c => c.id === 'python_services')!;
    const baseline = await evaluateMatchingCase(c, 'retrieval');
    const llm: LLMClient = { provider: 'scripted', model: 'fixture', chat: async req => {
      const input = JSON.parse((req.messages[0] as { text: string }).text);
      const r = input.requirements[0], source = input.sources.find((s: any) => s.source === 'experience.md');
      return { text: JSON.stringify({ items: [{ requirementId: r.id, criteria: [{ criterionId: r.criteria[0].id, verdict: 'supported', evidence: [{ sourceId: source.id, quote: c.goldEvidence[0]!.quote }], reason: 'Direct fixture evidence', missingInformation: [] }] }] }), toolCalls: [], finish: 'stop', usage: { inputTokens: 2, outputTokens: 1 } };
    } };
    const result = await evaluateMatchingCase(c, 'assessment', { llm });
    expect(baseline.exact).toBe(true);
    expect(result).toMatchObject({ exact: true, citations: 1, goldAlignedCitations: 1, modelCalls: 1 });
    const summary = summarizeMatching([result, { ...result, predicted: null, completed: false, exact: false, citations: 0, goldAlignedCitations: 0 }]);
    expect(summary.completion).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(summary.falseRejection).toMatchObject({ numerator: 1, denominator: 2 });
    expect(summary.falseSupport.rate).toBeNull();
  });
});

it('keeps provider failure in the comparison denominator and error count', async () => {
  const c = (await loadMatchingCases())[0]!;
  const row = await evaluateMatchingCase(c, 'assessment', { llm: { provider: 'test', model: 'broken', chat: async () => { throw new Error('provider unavailable'); } } });
  expect(row.completed).toBe(false);
  expect(summarizeMatching([row])).toMatchObject({ total: 1, errors: 1, completion: { numerator: 0, denominator: 1 } });
});
