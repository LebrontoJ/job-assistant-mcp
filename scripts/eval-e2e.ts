import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { RuntimeSchema,SplitSchema,MatchModeSchema,FaultSchema } from '../evals/e2e/types.js';
import { loadCases,verifyFixtures,hash } from '../evals/e2e/load.js';
import { runCase } from '../evals/e2e/runner.js';
import { buildReport,sourceManifest } from '../evals/e2e/report.js';
import { LedgerSchema,auditEligible } from '../evals/e2e/review.js';
import { ReplaySchema } from '../evals/e2e/comparison.js';
import { createSemanticJudge } from '../evals/e2e/grading.js';
import { createLLM } from '../src/agent/llm/index.js';
import { createMatching } from '../src/matching/factory.js';
const args=process.argv.slice(2),allowed=new Set(['mode','split','match-mode','repeat','limit','output','fault','case-timeout-ms','purpose','reviews','compare','parser-replay','judge-provider','judge-model','gate']);
const values:Record<string,string>={};for(const arg of args){const m=arg.match(/^--([\w-]+)=(.+)$/);if(!m||!allowed.has(m[1]!))throw new Error(`Use documented --name=value flags: ${arg}`);values[m[1]!]=m[2]!;}
const runtime=RuntimeSchema.parse(values.mode??'offline'),split=SplitSchema.parse(values.split??'dev'),purpose=values.purpose??'development';
if(!['development','audit'].includes(purpose))throw new Error('purpose must be development or audit');
const compare=values.compare;
if(compare&&compare!=='matching')throw new Error('compare must be matching');
if(compare&&runtime==='offline')throw new Error('Matching comparison needs scripted or live mode');
const modes=compare?['retrieval','assessment','agent'] as const:[MatchModeSchema.parse(values['match-mode']??(runtime==='offline'?'retrieval':'agent'))];
const fault=FaultSchema.parse(values.fault??'none');
if(runtime==='offline'&&modes[0]!=='retrieval')throw new Error('Offline mode is retrieval only');
if(fault!=='none'&&(runtime!=='scripted'||modes.length!==1||modes[0]!=='agent'))throw new Error('Fault injection requires scripted agent mode');
const integer=(name:string,fallback:number,max:number)=>{const n=Number(values[name]??fallback);if(!Number.isInteger(n)||n<1||n>max)throw new Error(`Invalid ${name}`);return n;};
const repeat=integer('repeat',1,10),limit=integer('limit',Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER),caseTimeoutMs=integer('case-timeout-ms',240000,600000);
const reviewText=values.reviews?await readFile(values.reviews,'utf8'):undefined;
const records=reviewText?LedgerSchema.parse(JSON.parse(reviewText)).records:[];
if(split==='heldout'&&purpose!=='audit')throw new Error('Frozen acceptance execution requires --purpose=audit and independent reviews');
if(purpose==='audit'&&(runtime!=='live'||repeat<3||values.limit||fault!=='none'||values['parser-replay']))throw new Error('Official audit requires live full workflows, all cases, >=3 samples and no injected faults/parser replay');
const allCases=await loadCases(split),cases=allCases.slice(0,limit);
if(purpose==='audit'&&cases.some(({task,profile})=>!auditEligible(task,profile,records)))throw new Error('Audit locked: labels are missing independent agreement, disputed or stale');
const replayText=values['parser-replay']?await readFile(values['parser-replay'],'utf8'):undefined;
const replay=replayText?ReplaySchema.parse(JSON.parse(replayText)):undefined;
if(replay&&cases.some(({task})=>replay.cases[task.id]?.jdHash!==hash(task.jd)))throw new Error('Replay must match every selected raw JD hash');
if(runtime==='live'){try{process.loadEnvFile('.env');}catch{/* explicit environment */}}
let judge:ReturnType<typeof createSemanticJudge>|undefined;
const judgeUsage={calls:0,inputTokens:0,outputTokens:0};let judgeIdentity:unknown;
if(values['judge-provider']||values['judge-model']){
  if(runtime!=='live')throw new Error('External judge requires explicit live mode');
  const client=createLLM({provider:values['judge-provider'],model:values['judge-model']});
  const tested=[createLLM(),...(modes.some(m=>m!=='retrieval')?[createMatching({...process.env,MATCH_MODE:'assessment',MATCH_CACHE:'off'}).llm!]:[])];
  if(tested.some(t=>t.provider===client.provider&&t.model===client.model))throw new Error('Judge model must differ from draft and matching models');
  judgeIdentity={provider:client.provider,model:client.model};
  judge=createSemanticJudge({provider:client.provider,model:client.model,chat:async req=>{judgeUsage.calls++;const response=await client.chat(req);judgeUsage.inputTokens+=response.usage.inputTokens;judgeUsage.outputTokens+=response.usage.outputTokens;return response;}});
}
const gate=values.gate??'report';if(!['report','pass'].includes(gate))throw new Error('gate must be report or pass');
const results=[];
for(let sample=0;sample<repeat;sample++)for(const {task,profile} of cases)for(const matchMode of modes){
  const result=await runCase(task,profile,{runtime,matchMode,sample,fault,caseTimeoutMs,judge,officialEligible:auditEligible(task,profile,records),parserReplay:replay?.cases[task.id]});
  results.push(result);console.error(`${sample+1}/${repeat} ${matchMode} ${task.id} ${result.outcome}`);
}
const report=buildReport(results,{...await sourceManifest(),fixtures:await verifyFixtures(),runtime,modes,split,purpose,repeat,fault,caseTimeoutMs,cache:'disabled',reviewHash:reviewText?hash(reviewText):null,parserReplayHash:replayText?hash(replayText):null,judge:judgeIdentity,judgeUsage,seed:'fixed synthetic inputs; independent call sample ids; scripted repetitions are deterministic host tests'});
console.log(JSON.stringify(report,null,2));
if(values.output){await mkdir(dirname(values.output),{recursive:true});await writeFile(values.output,JSON.stringify(report,null,2)+'\n');}
if(results.some(r=>r.outcome==='run_error'))process.exitCode=2;
else if(gate==='pass'&&results.some(r=>r.outcome!=='passed'))process.exitCode=1;
