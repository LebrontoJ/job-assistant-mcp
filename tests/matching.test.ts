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
