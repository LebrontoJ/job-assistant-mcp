import { describe,it,expect } from 'vitest';
import { summarize,buildReport } from '../evals/e2e/report.js';
import { createEnvironment } from '../evals/e2e/environment.js';
import { runCase } from '../evals/e2e/runner.js';
import { loadCases } from '../evals/e2e/load.js';
import type { E2EResult } from '../evals/e2e/types.js';
const row=(outcome:E2EResult['outcome']):E2EResult=>({caseId:'a',profileId:'p',jdFamily:'j',split:'dev',sample:0,runtime:'scripted',matchMode:'agent',track:'workflow',experiment:'full_workflow',fault:'none',officialEligible:false,outcome,completed:outcome!=='run_error',checks:[{dimension:'grounding',name:'semantic',state:outcome==='ungraded'?'ungraded':outcome==='failed'?'fail':'pass',required:true,detail:''}],stages:[],errors:[],ms:10,usage:{modelCalls:0,inputTokens:0,outputTokens:0,parserCalls:0,parserInputTokens:0,parserOutputTokens:0}});
describe('e2e reports and bounds',()=>{
  it('keeps all runs in task success and separates fault tracks and runtimes',()=>{
    const rows=[row('passed'),row('failed'),row('ungraded'),{...row('run_error'),checks:[]}];
    const summary=summarize(rows);expect(summary.taskSuccess).toEqual({numerator:1,denominator:4,rate:.25});expect(summary.gradingCompletion).toMatchObject({numerator:2,denominator:4});expect(summary.factualSupport.rate).toBeNull();
    const report=buildReport([...rows,{...row('passed'),track:'reliability',fault:'lost_response'}],{});expect(Object.keys(report.byGroup)).toHaveLength(2);
  });
  it('bounds a hanging startup factory',async()=>{const {task,profile}=(await loadCases('dev'))[0]!;const result=await runCase(task,profile,{runtime:'offline',matchMode:'retrieval',caseTimeoutMs:30,makeEnvironment:async()=>new Promise(()=>{})});expect(result.outcome).toBe('run_error');expect(result.errors[0]?.stage).toBe('startup');});
  it('bounds a hanging grader without accepting it as a pass',async()=>{
    const {task,profile}=(await loadCases('dev'))[0]!;
    const result=await runCase(task,profile,{runtime:'offline',matchMode:'retrieval',caseTimeoutMs:2000,grade:async()=>new Promise(()=>{})});
    expect(result.outcome).toBe('run_error');expect(result.errors[0]?.stage).toBe('grading');
  });
  it('retains cleanup failures even when the workflow passes',async()=>{
    const {task,profile}=(await loadCases('dev'))[0]!;
    const result=await runCase(task,profile,{runtime:'offline',matchMode:'retrieval',makeEnvironment:async(...args)=>{const env=await createEnvironment(...args);return {...env,close:async()=>{await env.close();throw new Error('cleanup failure');}};}});
    expect(result.outcome).toBe('run_error');expect(result.errors).toContainEqual({stage:'cleanup',kind:'cleanup_error'});
  });
  it('records a grader exception as ungraded rather than a model failure',async()=>{const {task,profile}=(await loadCases('dev'))[0]!;const result=await runCase(task,profile,{runtime:'scripted',matchMode:'agent',grade:async()=>{throw new Error('bad judge');}});expect(result.outcome).toBe('ungraded');expect(result.errors).toEqual([]);});
});
