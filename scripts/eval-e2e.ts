import { mkdir,writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { RuntimeSchema,SplitSchema,MatchModeSchema,FaultSchema } from '../evals/e2e/types.js';
import { loadCases,verifyFixtures } from '../evals/e2e/load.js';
import { runCase } from '../evals/e2e/runner.js';
import { buildReport,sourceManifest } from '../evals/e2e/report.js';
const args=process.argv.slice(2),allowed=new Set(['mode','split','match-mode','repeat','limit','output','fault','case-timeout-ms']);
const values:Record<string,string>={};for(const arg of args){const m=arg.match(/^--([\w-]+)=(.+)$/);if(!m||!allowed.has(m[1]!))throw new Error(`Use documented --name=value flags: ${arg}`);values[m[1]!]=m[2]!;}
const runtime=RuntimeSchema.parse(values.mode??'offline'),split=SplitSchema.parse(values.split??'dev');
if(split==='heldout')throw new Error('Frozen acceptance execution requires the independent review gate (not yet unlocked).');
const matchMode=MatchModeSchema.parse(values['match-mode']??(runtime==='offline'?'retrieval':'agent'));
const fault=FaultSchema.parse(values.fault??'none');
if(runtime==='offline'&&matchMode!=='retrieval')throw new Error('Offline mode is retrieval only');
if(fault!=='none'&&(runtime!=='scripted'||matchMode!=='agent'))throw new Error('Fault injection requires scripted agent mode');
const integer=(name:string,fallback:number,max:number)=>{const n=Number(values[name]??fallback);if(!Number.isInteger(n)||n<1||n>max)throw new Error(`Invalid ${name}`);return n;};
const repeat=integer('repeat',1,10),limit=integer('limit',Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER),caseTimeoutMs=integer('case-timeout-ms',240000,600000);
if(runtime==='live'){try{process.loadEnvFile('.env');}catch{/* explicit environment */}}
const cases=(await loadCases(split)).slice(0,limit),results=[];
for(let sample=0;sample<repeat;sample++)for(const {task,profile} of cases){const result=await runCase(task,profile,{runtime,matchMode,sample,fault,caseTimeoutMs});results.push(result);console.error(`${sample+1}/${repeat} ${task.id} ${result.outcome}`);}
const report=buildReport(results,{...await sourceManifest(),fixtures:await verifyFixtures(),runtime,matchMode,split,repeat,fault,caseTimeoutMs,cache:'disabled',seed:'fixed synthetic fixtures; sample indices identify independent calls'});
console.log(JSON.stringify(report,null,2));
if(values.output){await mkdir(dirname(values.output),{recursive:true});await writeFile(values.output,JSON.stringify(report,null,2)+'\n');}
if(results.some(r=>r.outcome==='run_error'))process.exitCode=2;
