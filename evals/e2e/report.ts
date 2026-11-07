import { pairedComparisons } from './comparison.js';
import { execFileSync } from 'node:child_process';
import { readdir,readFile } from 'node:fs/promises';
import { hash } from './load.js';
import type { E2EResult } from './types.js';
export const ratio=(numerator:number,denominator:number)=>({numerator,denominator,rate:denominator?numerator/denominator:null});
const percentile=(values:number[],p:number)=>{if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]!;};
export function summarize(rows:E2EResult[]) {
  const checks=rows.flatMap(r=>r.checks),dimensions:Record<string,{pass:number;fail:number;ungraded:number;skipped:number}>={};
  for(const check of checks){const counts=dimensions[check.dimension]??={pass:0,fail:0,ungraded:0,skipped:0};counts[check.state]++;}
  const metric=(name:string)=>{const entries=checks.filter(c=>c.name===name&&c.numerator!==undefined&&c.denominator!==undefined);return ratio(entries.reduce((s,c)=>s+c.numerator!,0),entries.reduce((s,c)=>s+c.denominator!,0));};
  const claims=checks.filter(c=>/^claim_\d+_support$/.test(c.name)),unknownClaims=checks.filter(c=>/^claim_\d+_semantic$/.test(c.name));
  const citations=checks.filter(c=>/^claim_\d+_citation$/.test(c.name));
  const stageNames=[...new Set(rows.flatMap(r=>r.stages.map(s=>s.name)))];
  return {total:rows.length,outcomes:Object.fromEntries(['passed','failed','ungraded','run_error'].map(o=>[o,rows.filter(r=>r.outcome===o).length])),
    operationalCompletion:ratio(rows.filter(r=>r.completed).length,rows.length),
    taskSuccess:ratio(rows.filter(r=>r.outcome==='passed').length,rows.length),
    gradingCompletion:ratio(rows.filter(r=>r.checks.some(c=>c.required)&&r.checks.filter(c=>c.required).every(c=>c.state==='pass'||c.state==='fail')).length,rows.length),
    reviewed:rows.filter(r=>r.officialEligible).length,provisional:rows.filter(r=>!r.officialEligible).length,
    dimensions,requirementCoverage:metric('requirement_coverage'),requirementPrecision:metric('requirement_precision'),taskEvidenceRecall:metric('task_evidence_recall'),matchingAccuracy:metric('requirement_judgments'),falseSupport:metric('false_support'),falseRejection:metric('false_rejection'),
    factualSupport:ratio(claims.filter(c=>c.state==='pass').length,claims.length),unsupportedClaims:ratio(claims.filter(c=>c.state==='fail').length,claims.length),claimGradingCoverage:ratio(claims.length,claims.length+unknownClaims.length),citationSupport:ratio(citations.filter(c=>c.state==='pass').length,citations.length),
    usage:rows.reduce((s,r)=>{for(const key of Object.keys(s) as Array<keyof typeof s>)s[key]+=r.usage[key];return s;},{modelCalls:0,inputTokens:0,outputTokens:0,parserCalls:0,parserInputTokens:0,parserOutputTokens:0}),
    latency:{p50:percentile(rows.map(r=>r.ms),.5),p95:percentile(rows.map(r=>r.ms),.95),byStage:Object.fromEntries(stageNames.map(name=>{const values=rows.flatMap(r=>r.stages.filter(s=>s.name===name).map(s=>s.ms));return [name,{p50:percentile(values,.5),p95:percentile(values,.95)}];}))},
    failures:rows.filter(r=>r.outcome!=='passed').map(r=>({caseId:r.caseId,sample:r.sample,stageErrors:r.errors,checks:r.checks.filter(c=>c.required&&c.state!=='pass').map(c=>({dimension:c.dimension,name:c.name,state:c.state}))}))};
}
export async function sourceManifest() {
  const files=['package.json','pnpm-lock.yaml','tsconfig.json'];
  for(const root of ['src','evals/e2e','scripts'])for(const entry of await readdir(root,{recursive:true}))if(/\.(?:ts|js|css|html|json|jsonl)$/.test(entry))files.push(`${root}/${entry}`);
  let revision='unknown',dirty=true;
  try{revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();dirty=!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim();}catch{/* non-Git checkout */}
  return {revision,dirty,node:process.version,files:Object.fromEntries(await Promise.all(files.sort().map(async file=>[file,hash(await readFile(file))])))};
}
export function buildReport(results:E2EResult[],manifest:unknown) {
  const groups=[...new Set(results.map(r=>`${r.runtime}/${r.matchMode}/${r.track}/${r.experiment}`))];
  return {version:'e2e-v1',date:new Date().toISOString(),manifest,
    scope:'Synthetic candidate data. Unreviewed labels are provisional. Scripted/reliability results measure host behavior, never live model quality. Known tokens exclude unavailable failed-call usage.',
    comparisons:pairedComparisons(results),
    byGroup:Object.fromEntries(groups.map(key=>[key,summarize(results.filter(r=>`${r.runtime}/${r.matchMode}/${r.track}/${r.experiment}`===key))])),results};
}
