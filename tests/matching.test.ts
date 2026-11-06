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
