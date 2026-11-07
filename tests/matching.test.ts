import { describe, expect, it } from 'vitest';
import { aggregate, requirementsOf, summaryOf, type CriterionAssessment } from '../src/matching/types.js';
const criterion = (verdict: CriterionAssessment['verdict']): CriterionAssessment => ({ criterionId: 'c', verdict, evidence: [], reason: 'reason', missingInformation: [] });
describe('requirement contracts', () => {
  it('retains original compound requirements and deterministic clause identities', () => {
    const jd = { requirements: ['Python and SQL; production ownership'], niceToHave: ['Go'] };
    const result = requirementsOf(jd);
    expect(result).toEqual(requirementsOf(jd));
    expect(result[0]?.originalText).toBe(jd.requirements[0]);
    expect(result[0]?.criteria.map(c => c.text)).toEqual(['Python and SQL', 'production ownership']);
    expect(result[1]?.kind).toBe('nice_to_have');
  });
  it('never aggregates partial or missing criteria into full support', () => {
    expect(aggregate([criterion('supported'), criterion('insufficient')])).toBe('partial');
    expect(aggregate([criterion('supported'), criterion('contradicted')])).toBe('contradicted');
    expect(aggregate([criterion('supported')])).toBe('supported');
    const requirement = requirementsOf({ requirements: ['Python'], niceToHave: [] })[0]!;
    expect(summaryOf([{ requirement, verdict: null, assessmentStatus: 'timeout', criteria: [] }]).requirement).toMatchObject({ assessed: 0, unassessed: 1, supported: 0 });
  });
});

import { collectEvidence, addSources } from '../src/matching/evidence.js';
import { ProfileIndex } from '../src/rag/index.js';
import { matchProfile } from '../src/server/match.js';
import { parseJd } from '../src/server/jd.js';
describe('complete evidence collection', () => {
  it('retains complete passages once and explicitly marks omitted requirements', async () => {
    const source = { id: 'p.md#0', source: 'p.md', heading: 'Production', text: 'Python production services. '.repeat(20) };
    let searches = 0;
    const bundle = await collectEvidence({ requirements: ['Python', 'Production', 'Go'], niceToHave: [] }, async () => { searches++; return [source]; }, { maxRequirements: 2 });
    expect(searches).toBe(2);
    expect(bundle.sources).toHaveLength(1);
    expect(bundle.sources[0]?.text).toBe(source.text);
    expect(bundle.packets[2]?.retrievalStatus).toBe('context_limited');
    expect(() => addSources(bundle, bundle.packets[0]!.requirement.id, [{ ...source, text: 'changed' }])).toThrow('Source changed');
  });
  it('never presents a clipped passage as complete context', async () => {
    const bundle = await collectEvidence({ requirements: ['Python'], niceToHave: [] }, async () => [{ id: 'p', source: '', heading: '', text: 'too long' }], { maxChars: 2 });
    expect(bundle.sources).toEqual([]);
    expect(bundle.packets[0]?.retrievalStatus).toBe('context_limited');
  });
  it('reuses matching hits while keeping the legacy retrieval labels unchanged', async () => {
    const index = ProfileIndex.fromMarkdown({ 'p.md': '# Experience\n' + 'Python services '.repeat(30) });
    const jd = parseJd('Backend Engineer\nRequirements:\n- Python services');
    const baseline = await matchProfile(jd, index);
    const enriched = await matchProfile(jd, index, { includeEvidence: true });
    expect(enriched.items).toEqual(baseline.items);
    expect(enriched.evidenceBundle?.sources[0]?.text.length).toBeGreaterThan(160);
  });
});

import { assessBatch, validateAssessment } from '../src/matching/assessor.js';
import type { LLMClient } from '../src/agent/llm/types.js';
const fixtureBundle = () => collectEvidence({ requirements: ['Built Python services'], niceToHave: [] }, async () => [{ id: 'p', source: '', heading: '', text: 'Built Python services.' }]);
const outputFor = (bundle: Awaited<ReturnType<typeof fixtureBundle>>, over: object = {}) => ({ items: bundle.packets.map(p => ({ requirementId: p.requirement.id, criteria: p.requirement.criteria.map(c => ({ criterionId: c.id, verdict: 'supported', evidence: [{ sourceId: 'p', quote: 'Built Python services.' }], reason: 'Direct evidence', missingInformation: [], ...over })) })) });
describe('structured assessment host validation', () => {
  it('accepts real quotes and rejects fabricated quotes, unknown sources, omissions and duplicates', async () => {
    const bundle = await fixtureBundle();
    const requirements = bundle.packets.map(p => p.requirement);
    expect(validateAssessment(outputFor(bundle), bundle, requirements).items[0]?.verdict).toBe('supported');
    for (const evidence of [[{ sourceId: 'unknown', quote: 'Built Python services.' }], [{ sourceId: 'p', quote: 'Led production operations.' }], []]) {
      expect(validateAssessment(outputFor(bundle, { evidence }), bundle, requirements).items[0]?.verdict).toBeNull();
    }
    expect(validateAssessment({ items: [] }, bundle, requirements).items[0]?.assessmentStatus).toBe('failed');
    const output = outputFor(bundle); output.items.push(output.items[0]!);
    expect(validateAssessment(output, bundle, requirements).items[0]?.verdict).toBeNull();
  });
  it('does not claim verified years from a model verdict', async () => {
    const bundle = await collectEvidence({ requirements: ['3 years Python'], niceToHave: [] }, async () => [{ id: 'p', source: '', heading: '', text: 'Built Python services.' }]);
    expect(validateAssessment(outputFor(bundle), bundle, bundle.packets.map(p => p.requirement)).items[0]?.verdict).toBe('partial');
  });
  it('repairs malformed output once without accepting fabricated evidence', async () => {
    const bundle = await fixtureBundle();
    let calls = 0;
    const llm: LLMClient = { provider: 'test', model: 'test', chat: async req => {
      expect(req.responseSchema).toBeDefined(); calls++;
      return { text: calls === 1 ? 'invalid' : JSON.stringify(outputFor(bundle)), finish: 'stop', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
    } };
    expect((await assessBatch(llm, bundle, bundle.packets.map(p => p.requirement))).items[0]?.verdict).toBe('supported');
    expect(calls).toBe(2);
  });
});
