import { runFault } from './faults.js';
import { gradeWorkflow, type SemanticJudge } from './grading.js';
import type { TaskReport } from '../../src/agent/task.js';
import { createEnvironment, type E2EEnvironment, type EnvironmentOptions } from './environment.js';
import { canonical,hash } from './load.js';
import type { E2ECase,E2EProfile,E2EResult,Check,Stage } from './types.js';
export interface Observation {
  report?: TaskReport; initial: ReturnType<E2EEnvironment['inspect']>; analysed?: ReturnType<E2EEnvironment['inspect']>;
  preview?: ReturnType<E2EEnvironment['inspect']>; final?: ReturnType<E2EEnvironment['inspect']>;
  previewResponse?: any; decisionResponse?: any; retryResponse?: any;
}
export interface RunOptions extends EnvironmentOptions {
  judge?:SemanticJudge;
  sample?:number; officialEligible?:boolean; artifacts?:boolean;
  grade?: (observation:Observation,task:E2ECase,profile:E2EProfile)=>Promise<Check[]>;
  makeEnvironment?:typeof createEnvironment;
}
export function decideOutcome(checks:Check[],errors:E2EResult['errors']):E2EResult['outcome'] {
  if(errors.length)return 'run_error';
  if(checks.some(c=>c.required&&c.state==='fail'))return 'failed';
  if(checks.some(c=>c.required&&(c.state==='ungraded'||c.state==='skipped')))return 'ungraded';
  return checks.some(c=>c.required)?'passed':'ungraded';
}
export async function runCase(task:E2ECase,profile:E2EProfile,opts:RunOptions):Promise<E2EResult> {
  const controller=new AbortController();
  const timeoutMs=opts.caseTimeoutMs??240000;
  if(!Number.isInteger(timeoutMs)||timeoutMs<1)throw new Error('Invalid case timeout');
  const timer=setTimeout(()=>controller.abort(new DOMException('Case deadline exceeded','TimeoutError')),timeoutMs);
  const signal=opts.signal?AbortSignal.any([opts.signal,controller.signal]):controller.signal;
  const started=Date.now(),stages:Stage[]=[],errors:E2EResult['errors']=[],checks:Check[]=[];
  let environment:E2EEnvironment|undefined,observation:Observation|undefined,active='startup';
  const stage=async<T>(name:string,fn:()=>Promise<T>):Promise<T>=>{active=name;const start=Date.now();try{const out=await fn();stages.push({name,ms:Date.now()-start,status:'ok'});return out;}catch(e){stages.push({name,ms:Date.now()-start,status:'error'});throw e;}};
  const assert=(name:string,pass:boolean,detail='')=>checks.push({dimension:'writing',name,state:pass?'pass':'fail',required:true,detail});
  try {
    if(opts.fault&&opts.fault!=='none'&&(opts.runtime!=='scripted'||opts.matchMode!=='agent'))throw new Error('Faults require scripted agent mode');
    environment=await stage('startup',async()=>{
      const pending=(opts.makeEnvironment??createEnvironment)(profile,{...opts,signal});
      void pending.then(late=>{if(signal.aborted&&!environment)return late.close();}).catch(()=>{});
      let abort:()=>void=()=>{};
      try{return await Promise.race([pending,new Promise<never>((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();})]);}
      finally{signal.removeEventListener('abort',abort);}
    });
    if(opts.fault&&opts.fault!=='none'){
      const result=await stage('reliability',()=>runFault(environment!,task,opts.fault as Exclude<NonNullable<RunOptions['fault']>,'none'>));
      observation=result.observation;checks.push(...result.checks);
    }else{
    observation={initial:environment.inspect()};
    const analysed=await stage('analyse',()=>environment!.request('/api/analyse',{jd:task.jd}));
    if(analysed.status!==200)throw new Error(`HTTP ${analysed.status}`);
    observation.report=analysed.data;observation.analysed=environment.inspect();
    assert('analysis_is_read_only',canonical(observation.initial.applications)===canonical(observation.analysed.applications));
    const preview=await stage('preview',()=>environment!.request('/api/preview',{taskId:observation!.report!.taskId,...task.tracking}));
    if(preview.status!==200||preview.data.status!=='pending_confirmation')throw new Error(`Preview HTTP ${preview.status}`);
    observation.previewResponse=preview.data;observation.preview=environment.inspect();
    assert('preview_is_read_only',canonical(observation.initial.applications)===canonical(observation.preview.applications));
    const operationId=preview.data.operation.id;
    if(task.workflow!=='no_decision') {
      observation.decisionResponse=await stage('decision',()=>environment!.request('/api/decision',{operationId,decision:task.workflow==='cancel'?'cancel':'approve'}));
      if(task.workflow==='retry_same_key')observation.retryResponse=await stage('retry_same_key',()=>environment!.request('/api/decision',{operationId,decision:'approve'}));
      if(task.workflow==='cancel')observation.retryResponse=await stage('reject_cancelled_approval',()=>environment!.request('/api/decision',{operationId,decision:'approve'}));
    }
    observation.final=environment.inspect();
    if(task.workflow==='cancel'||task.workflow==='no_decision') {
      assert('no_unapproved_mutation',canonical(observation.initial.applications)===canonical(observation.final.applications));
      if(task.workflow==='cancel')assert('cancel_is_durable',observation.decisionResponse.status===200&&observation.retryResponse.status===409&&observation.final.operations.some(o=>o.id===operationId&&o.cancelled===1));
    } else {
      const added=observation.final.applications.filter(a=>!observation!.initial.applications.some(i=>i.id===a.id));
      const expectedNotes=observation.report!.draft.rewrites.map(c=>`${c.text} [${c.evidenceIds.join(', ')}]`).join('\n');
      assert('exact_approved_write',observation.decisionResponse.status===200&&added.length===1&&observation.final.applications.length===observation.initial.applications.length+1&&added[0]?.company===task.tracking.company&&added[0]?.role===task.tracking.role&&added[0]?.status===task.tracking.status&&added[0]?.notes===expectedNotes&&added[0]?.version===1);
      assert('operation_result_committed',observation.final.operations.some(o=>o.id===operationId&&!!o.result));
      if(task.workflow==='retry_same_key')assert('idempotent_retry',observation.retryResponse.status===200&&canonical(observation.retryResponse.data)===canonical(observation.decisionResponse.data));
    }
    try{checks.push(...await stage('grading',()=>opts.grade ? opts.grade(observation!,task,profile) : gradeWorkflow(observation!,task,profile,opts.judge)));}
    catch{checks.push({dimension:'grounding',name:'grader_error',state:'ungraded',required:true,detail:'Grader failed; no model verdict inferred'});}
    }
  } catch(error) {errors.push({stage:active,kind:error instanceof Error&&/HTTP \d+/.test(error.message)?error.message:'execution_error'});}
  finally {clearTimeout(timer);if(environment)try{await stage('cleanup',()=>environment!.close());}catch{errors.push({stage:'cleanup',kind:'cleanup_error'});}}
  const events=environment?.tracer.events??[];
  const usage={modelCalls:0,inputTokens:0,outputTokens:0,parserCalls:0,parserInputTokens:0,parserOutputTokens:0};
  for(const e of events)if(e.type==='llm_call'){usage.modelCalls++;usage.inputTokens+=e.inputTokens;usage.outputTokens+=e.outputTokens;}else if(e.type==='jd_parse'){usage.parserCalls+=e.apiCalls;usage.parserInputTokens+=e.inputTokens;usage.parserOutputTokens+=e.outputTokens;}
  return {caseId:task.id,profileId:task.profileId,jdFamily:task.jdFamily,split:task.split,sample:opts.sample??0,runtime:opts.runtime,matchMode:opts.runtime==='offline'?'retrieval':opts.matchMode,experiment:opts.parserReplay?'matching_ablation':'full_workflow',track:opts.fault&&opts.fault!=='none'?'reliability':'workflow',fault:opts.fault??'none',officialEligible:opts.officialEligible??false,outcome:decideOutcome(checks,errors),completed:!!observation?.final&&!errors.length,checks,stages,errors,ms:Date.now()-started,usage,
    ...(opts.artifacts===false?{}:{artifacts:{inputJdHash:hash(task.jd),configuration:environment?.configuration,report:observation?.report,checks,trace:events.map(e=>{const {user,args,result,detail,...safe}=e as any;return safe;})}})};
}
