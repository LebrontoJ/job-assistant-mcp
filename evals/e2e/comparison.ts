import { ParsedJdSchema } from '../../src/parsing/jd.js';
import { z } from 'zod';
import type { E2EResult } from './types.js';
export const ReplaySchema=z.object({kind:z.literal('e2e-parser-replay-v1'),cases:z.record(z.string(),z.object({jdHash:z.string(),data:ParsedJdSchema}).strict())}).strict();
export type ParserReplay=z.infer<typeof ReplaySchema>['cases'][string];
export function pairedComparisons(rows:E2EResult[]){
  const pairs=[];
  for(const agent of rows.filter(r=>r.track==='workflow'&&r.matchMode==='agent')){
    const baseline=rows.find(r=>r.track==='workflow'&&r.runtime===agent.runtime&&r.experiment===agent.experiment&&r.caseId===agent.caseId&&r.sample===agent.sample&&r.matchMode==='assessment');
    if(baseline)pairs.push({caseId:agent.caseId,sample:agent.sample,recovered:baseline.outcome!=='passed'&&agent.outcome==='passed',regressed:baseline.outcome==='passed'&&agent.outcome!=='passed',bothGraded:!['ungraded','run_error'].includes(baseline.outcome)&&!['ungraded','run_error'].includes(agent.outcome)});
  }
  return {pairs,recovered:pairs.filter(p=>p.recovered).length,regressed:pairs.filter(p=>p.regressed).length,scope:'Paired task outcomes, including execution/grading failures; not purely semantic gain.'};
}
