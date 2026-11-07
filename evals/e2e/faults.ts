import type { E2EEnvironment } from './environment.js';
import type { Observation } from './runner.js';
import type { E2ECase,Fault,Check } from './types.js';
import { canonical } from './load.js';
const wait=async<T>(p:Promise<T>)=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([p,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Fault observation timed out')),3000);})]);}finally{clearTimeout(timer);}};
export async function runFault(env:E2EEnvironment,task:E2ECase,fault:Exclude<Fault,'none'>):Promise<{observation:Observation;checks:Check[]}> {
  const observation:Observation={initial:env.inspect()},checks:Check[]=[];
  const check=(name:string,pass:boolean,detail='')=>checks.push({dimension:'reliability',name,state:pass?'pass':'fail',required:true,detail});
  if(fault==='version_conflict') {
    const app=await env.store.add({company:'Concurrent fixture',role:'Engineer'});
    const preview=await env.request('/api/preview',{id:app.id,status:'oa'});
    await env.store.update(app.id,{status:'interview'});const before=env.inspect();
    const decision=await env.request('/api/decision',{operationId:preview.data.operation.id,decision:'approve'});
    observation.final=env.inspect();
    check('stale_preview_rejected',decision.status===409&&canonical(before.applications)===canonical(observation.final.applications)&&!observation.final.operations.find(o=>o.id===preview.data.operation.id)?.result);
    return {observation,checks};
  }
  if(fault==='user_cancel') {
    const controller=new AbortController();
    const pending=env.request('/api/analyse',{jd:task.jd},controller.signal).then(value=>({value,error:false}),()=>({value:undefined,error:true}));
    await wait(env.scripted!.ready);controller.abort();const outcome=await wait(pending);await wait(env.scripted!.aborted);
    observation.final=env.inspect();
    check('user_cancellation_propagates',outcome.error&&canonical(observation.initial.applications)===canonical(observation.final.applications));
    return {observation,checks};
  }
  const result=await env.request('/api/analyse',{jd:task.jd});
  check('report_available',result.status===200);
  if(result.status!==200){observation.final=env.inspect();return {observation,checks};}
  const report=observation.report=result.data;
  observation.analysed=env.inspect();
  check('analysis_stays_read_only',canonical(observation.initial.applications)===canonical(observation.analysed.applications));
  if(fault==='parser_timeout')check('parser_timeout_falls_back',report.parsing?.method==='rules'&&report.parsing.fallbackReason==='timeout');
  if(fault==='match_failure')check('completed_matching_survives',report.assessment.items.some((i:any)=>i.assessmentStatus==='assessed')&&report.assessment.items.some((i:any)=>i.assessmentStatus==='failed')&&report.assessment.meta.executionErrors>0);
  if(fault==='search_failure')check('supplementary_failure_visible',report.assessment.meta.executionErrors>0&&report.assessment.meta.stoppedBecause!=='no_new_evidence'&&env.tracer.events.some(e=>e.type==='tool_attempt'&&e.name==='search_profile'&&!!e.errorKind));
  if(fault==='draft_failure')check('matching_retained_after_draft_failure',report.draftStatus==='unavailable'&&report.assessment.items.some((i:any)=>i.assessmentStatus==='assessed'));
  if(fault==='unapproved_write') {
    const attempted=await env.client.callTool({name:'add_application',arguments:{company:'Forbidden fixture',role:'Engineer',confirm:true}});
    check('unapproved_write_blocked',attempted.isError===true&&env.tracer.events.some(e=>e.type==='match_search'&&e.blocked));
  }
  if(fault==='lost_response') {
    const preview=await env.request('/api/preview',{taskId:report.taskId,...task.tracking});
    const body={operationId:preview.data.operation.id,decision:'approve'};
    // Drop the successful HTTP result at the client boundary, after the durable transaction.
    let lost=false;
    try {const response=await env.request('/api/decision',body);if(response.status!==200)throw new Error('Write failed before response loss');lost=true;throw new Error('Injected response loss');}catch(error){if(!lost)throw error;}
    const committed=env.inspect(),retry=await env.request('/api/decision',body);
    observation.final=env.inspect();
    const stored=observation.final.operations.find(o=>o.id===body.operationId);
    check('committed_response_loss_is_idempotent',lost&&retry.status===200&&observation.final.applications.length===observation.initial.applications.length+1&&canonical(committed.applications)===canonical(observation.final.applications)&&!!stored?.result&&JSON.parse(String(stored.result)).application.id===retry.data.application.id);
  }
  observation.final??=env.inspect();
  if(fault!=='lost_response')check('fault_does_not_mutate_tracker',canonical(observation.initial.applications)===canonical(observation.final.applications));
  return {observation,checks};
}
