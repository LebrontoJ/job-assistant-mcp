import { z } from 'zod';
import { GoldSchema,type E2ECase,type E2EProfile } from './types.js';
import { canonical,hash } from './load.js';
export const ReviewSchema=z.object({caseId:z.string(),caseHash:z.string(),reviewer:z.string().min(1),reviewerKind:z.literal('human'),gold:GoldSchema}).strict();
export interface ReviewRecord { review:z.infer<typeof ReviewSchema>; status:'agreed'|'disagreement'; reviewedAt:string }
export const LedgerSchema=z.object({version:z.literal('e2e-review-v1'),records:z.array(z.object({review:ReviewSchema,status:z.enum(['agreed','disagreement']),reviewedAt:z.string()}).strict())}).strict();
const normalizedGold=(gold:z.infer<typeof GoldSchema>)=>{
  const fact=(key:string)=>gold.facts.find(f=>f.key===key)!;
  const sort=(values:unknown[])=>values.map(canonical).sort();
  return canonical({title:gold.title,company:gold.company,requirements:sort(gold.requirements.map(({key,...r})=>({...r,evidence:sort(r.evidence)}))),facts:sort(gold.facts.map(({key,...f})=>f)),allowedDraftFacts:sort(gold.allowedDraftFactKeys.map(fact).map(({key,...f})=>f)),mustCoverFacts:sort(gold.mustCoverFactKeys.map(fact).map(({key,...f})=>f)),forbiddenClaims:[...gold.forbiddenClaims].sort(),minimumDraftFacts:gold.minimumDraftFacts,minimumRequirementRecall:gold.minimumRequirementRecall});
};
export function blindPacket(task:E2ECase,profile:E2EProfile){return {caseId:task.id,caseHash:hash(canonical(task)),jd:task.jd,profile:profile.documents,workflow:task.workflow,tracking:task.tracking,outputSchema:z.toJSONSchema(GoldSchema),instructions:'Independently label source-backed requirements, verdicts, facts and task rubric. Do not inspect author gold labels. Use arbitrary stable keys; source quotes must be exact. Return caseId, caseHash, reviewer, reviewerKind:"human", gold. Identity is a human declaration, not authenticated by this local tool.'};}
export function recordReview(task:E2ECase,profile:E2EProfile,value:unknown):ReviewRecord {
  const review=ReviewSchema.parse(value);
  if(review.caseId!==task.id||review.caseHash!==hash(canonical(task)))throw new Error('Review targets stale/different case');
  if(review.reviewer.trim().toLowerCase()===task.provenance.author.trim().toLowerCase())throw new Error('Reviewer must differ from author');
  for(const ref of [...review.gold.facts,...review.gold.requirements.flatMap(r=>r.evidence)])if(!profile.documents[ref.source]?.includes(ref.quote))throw new Error('Review quote absent from corpus');
  return {review,status:normalizedGold(review.gold)===normalizedGold(task.gold)?'agreed':'disagreement',reviewedAt:new Date().toISOString()};
}
export function auditEligible(task:E2ECase,profile:E2EProfile,records:ReviewRecord[]):boolean {
  const latest=new Map<string,ReviewRecord>();
  for(const record of records.filter(r=>r.review.caseId===task.id)) {
    try {const checked=recordReview(task,profile,record.review);if(checked.status!==record.status)continue;latest.set(record.review.reviewer.trim().toLowerCase(),record);}catch{/* stale/invalid review cannot unlock audit */}
  }
  return latest.size>0&&[...latest.values()].every(r=>r.status==='agreed');
}
