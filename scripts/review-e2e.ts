import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadCases } from '../evals/e2e/load.js';
import { SplitSchema } from '../evals/e2e/types.js';
import { blindPacket,recordReview,LedgerSchema,type ReviewRecord } from '../evals/e2e/review.js';
const values:Record<string,string>={};for(const arg of process.argv.slice(2)){const m=arg.match(/^--(action|split|input|output)=(.+)$/);if(!m)throw new Error('Use --action=export|record --split=... --input=... --output=...');values[m[1]!]=m[2]!;}
if(!values.output)throw new Error('Explicit --output is required');
const cases=await loadCases(SplitSchema.parse(values.split??'dev'));
let result:unknown;
if(values.action==='export')result={version:'e2e-blind-v1',cases:cases.map(({task,profile})=>blindPacket(task,profile))};
else if(values.action==='record'){
  if(!values.input)throw new Error('--input requires human-produced labels');
  const incoming=JSON.parse(await readFile(values.input,'utf8')) as unknown[];
  if(!Array.isArray(incoming))throw new Error('Human review input must be an array');
  let records:ReviewRecord[]=[];
  try{records=LedgerSchema.parse(JSON.parse(await readFile(values.output,'utf8'))).records;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  for(const review of incoming){const found=cases.find(c=>c.task.id===(review as any).caseId);if(!found)throw new Error('Unknown review case');records.push(recordReview(found.task,found.profile,review));}
  result={version:'e2e-review-v1',records};
}else throw new Error('Choose export or record');
await mkdir(dirname(values.output),{recursive:true});await writeFile(values.output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({action:values.action,output:values.output,scope:'Human declarations only; no review is auto-created.'}));
