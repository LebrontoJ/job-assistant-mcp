import { describe,expect,it } from 'vitest';
import { loadCases } from '../evals/e2e/load.js';
import { gradeWorkflow } from '../evals/e2e/grading.js';
import { decideOutcome,type Observation } from '../evals/e2e/runner.js';
import type { Check } from '../evals/e2e/types.js';
import type { TaskReport } from '../src/agent/task.js';
async function fixture(){const {task,profile}=(await loadCases('dev'))[0]!;const fact=task.gold.facts[0]!;const report={jd:{title:task.gold.title,company:task.gold.company,requirements:task.gold.requirements.filter(r=>r.kind==='requirement').map(r=>r.text),niceToHave:task.gold.requirements.filter(r=>r.kind==='nice_to_have').map(r=>r.text)},assessment:{mode:'retrieval'},evidence:[{id:'p',source:fact.source,text:fact.quote}],draft:{rewrites:[{text:fact.quote,evidenceIds:['p']}],suggestions:[]},draftStatus:'extractive',validation:[{supported:true}]} as unknown as TaskReport;return {task,profile,o:{report,initial:{applications:[],operations:[]}} as Observation};}
describe('independent end-to-end graders',()=>{
  it('fails empty positive drafts even if production validation reports success',async()=>{const {task,profile,o}=await fixture();o.report!.draft.rewrites=[];const checks=await gradeWorkflow(o,task,profile);expect(checks.find(c=>c.name==='useful_draft_coverage')?.state).toBe('fail');});
  it('rejects a forbidden invented claim despite production supported=true',async()=>{const {task,profile,o}=await fixture();o.report!.draft.rewrites=[{text:task.gold.forbiddenClaims[0]!,evidenceIds:['p']}];expect((await gradeWorkflow(o,task,profile)).find(c=>c.name==='claim_0_support')?.state).toBe('fail');});
  it('checks citation support beyond the presence of an id',async()=>{const {task,profile,o}=await fixture();o.report!.evidence[0]!.text='Unrelated passage.';expect((await gradeWorkflow(o,task,profile)).find(c=>c.name==='claim_0_citation')?.state).toBe('fail');});
  it('marks valid novel wording ungraded without a judge instead of declaring it wrong',async()=>{const {task,profile,o}=await fixture();o.report!.draft.rewrites[0]!.text='Developed booking services in Python.';const checks=await gradeWorkflow(o,task,profile);expect(checks.find(c=>c.name==='claim_0_semantic')?.state).toBe('ungraded');expect(checks.find(c=>c.name==='useful_draft_coverage')?.state).toBe('ungraded');});
  it('retains known failures alongside grader errors',()=>{const checks:Check[]=[{dimension:'coverage',name:'empty',state:'fail',required:true,detail:''},{dimension:'grounding',name:'judge',state:'ungraded',required:true,detail:''}];expect(decideOutcome(checks,[])).toBe('failed');expect(decideOutcome(checks.slice(1),[])).toBe('ungraded');});
});
