import { readFile,writeFile } from 'node:fs/promises';
import { ReplaySchema } from '../evals/e2e/comparison.js';
const [input,output]=process.argv.slice(2);if(!input||!output)throw new Error('Pass an e2e result JSON and explicit output path');
const report=JSON.parse(await readFile(input,'utf8'));const cases:Record<string,unknown>={};
for(const row of report.results??[])if(row.experiment==='full_workflow'&&row.track==='workflow'&&row.artifacts?.report){if(cases[row.caseId])continue;cases[row.caseId]={jdHash:row.artifacts.inputJdHash,data:row.artifacts.report.jd};}
await writeFile(output,JSON.stringify(ReplaySchema.parse({kind:'e2e-parser-replay-v1',cases}),null,2)+'\n');
