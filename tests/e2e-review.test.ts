import { describe,it,expect } from 'vitest';
import { loadCases,hash,canonical } from '../evals/e2e/load.js';
import { blindPacket,recordReview,auditEligible } from '../evals/e2e/review.js';
import { runCase } from '../evals/e2e/runner.js';
import { pairedComparisons } from '../evals/e2e/comparison.js';
describe('independent review and controlled comparisons',()=>{
  it('exports inputs and schema without author gold values',async()=>{
    const {task,profile}=(await loadCases('dev'))[0]!;const canary='PRIVATE_LABEL_CANARY';
    const packet=blindPacket({...task,gold:{...task.gold,forbiddenClaims:[canary]}},profile);
    expect(JSON.stringify(packet)).not.toContain(canary);expect(packet).not.toHaveProperty('gold');
  });
  it('never unlocks audit using missing, self, stale or disagreed labels',async()=>{
    const {task,profile}=(await loadCases('dev'))[0]!;const review={caseId:task.id,caseHash:hash(canonical(task)),reviewer:'test-human',reviewerKind:'human',gold:task.gold};
    expect(auditEligible(task,profile,[])).toBe(false);
    expect(()=>recordReview(task,profile,{...review,reviewer:'codex'})).toThrow('differ');
    expect(()=>recordReview(task,profile,{...review,caseHash:'stale'})).toThrow('stale');
    const agreed=recordReview(task,profile,review);expect(auditEligible(task,profile,[agreed])).toBe(true);
    const disagreement=recordReview(task,profile,{...review,gold:{...task.gold,minimumRequirementRecall:.9}});expect(auditEligible(task,profile,[disagreement])).toBe(false);
    // These simulated reviewers exist only in memory; no real review ledger is written.
  });
  it('labels parser replay as ablation and checks the raw input hash',async()=>{
    const {task,profile}=(await loadCases('dev'))[0]!;
    const fresh=await runCase(task,profile,{runtime:'scripted',matchMode:'assessment'});
    const parsed=(fresh.artifacts!.report as any).jd;
    const replayed=await runCase(task,profile,{runtime:'scripted',matchMode:'agent',parserReplay:{jdHash:hash(task.jd),data:parsed}});
    expect(replayed.experiment).toBe('matching_ablation');expect(replayed.usage.parserCalls).toBe(0);
    expect(pairedComparisons([fresh,replayed]).pairs).toHaveLength(0);
    expect(pairedComparisons([fresh,{...replayed,experiment:'full_workflow'}]).pairs).toHaveLength(1);
    const bad=await runCase(task,profile,{runtime:'scripted',matchMode:'agent',parserReplay:{jdHash:'wrong',data:parsed}});expect(bad.outcome).toBe('run_error');
  });
});
