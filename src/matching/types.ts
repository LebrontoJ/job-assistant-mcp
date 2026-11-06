import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ParsedJd } from '../server/jd.js';

export const MATCH_VERSION = 'match-v1';
export const VerdictSchema = z.enum(['supported', 'partial', 'insufficient', 'contradicted']);
export const ModeSchema = z.enum(['retrieval', 'assessment', 'agent']);
export type MatchMode = z.infer<typeof ModeSchema>;
const text = z.string().trim().min(1).max(4000);
export const RequirementSchema = z.object({
  id: text, originalText: text, kind: z.enum(['requirement', 'nice_to_have']),
  criteria: z.array(z.object({ id: text, text }).strict()).min(1).max(20),
}).strict();
export type Requirement = z.infer<typeof RequirementSchema>;
export const SourceSchema = z.object({ id: text, source: z.string(), heading: z.string(), text: z.string().min(1), hash: text }).strict();
export type Source = z.infer<typeof SourceSchema>;
export const CriterionAssessmentSchema = z.object({
  criterionId: text, verdict: VerdictSchema,
  evidence: z.array(z.object({ sourceId: text, quote: text }).strict()).max(8),
  reason: text, missingInformation: z.array(text).max(10),
}).strict();
export type CriterionAssessment = z.infer<typeof CriterionAssessmentSchema>;
export const AssessmentOutputSchema = z.object({
  items: z.array(z.object({ requirementId: text, criteria: z.array(CriterionAssessmentSchema).min(1).max(20) }).strict()).max(120),
}).strict();
export type AssessmentOutput = z.infer<typeof AssessmentOutputSchema>;
export interface AssessedRequirement {
  requirement: Requirement;
  verdict: z.infer<typeof VerdictSchema> | null;
  assessmentStatus: 'assessed' | 'unassessed' | 'timeout' | 'failed' | 'context_limited';
  criteria: CriterionAssessment[];
}
export interface EvidencePacket {
  requirement: Requirement;
  sourceIds: string[];
  retrievalStatus: 'complete' | 'no_hits' | 'context_limited';
}
export interface EvidenceBundle {
  packets: EvidencePacket[];
  sources: Source[];
  snapshotHash: string;
}
export interface MatchAssessment {
  version: string; mode: MatchMode; items: AssessedRequirement[]; sources: Source[];
  snapshotHash: string;
  summary: Record<'requirement' | 'nice_to_have', { total: number; assessed: number; supported: number; partial: number; insufficient: number; contradicted: number; unassessed: number }>;
  meta: { provider?: string; model?: string; cacheHit: boolean; modelCalls: number; inputTokens: number; outputTokens: number; searches: number; rounds: number; executionErrors: number; ms: number; stoppedBecause: string };
}
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Semicolons are explicit clause boundaries; do not split ambiguous English "and" expressions. */
export function requirementsOf(jd: Pick<ParsedJd, 'requirements' | 'niceToHave'>): Requirement[] {
  return ([['requirement', jd.requirements], ['nice_to_have', jd.niceToHave]] as const).flatMap(([kind, lines]) => lines.map((originalText, index) => {
    const id = `${kind}-${index}-${digest(originalText).slice(0, 10)}`;
    const clauses = originalText.split(/[;；]/).map(s => s.trim()).filter(Boolean);
    return RequirementSchema.parse({ id, originalText, kind, criteria: (clauses.length > 1 && clauses.length <= 20 ? clauses : [originalText]).map((text, i) => ({ id: `${id}:${i}`, text })) });
  }));
}
export function aggregate(criteria: CriterionAssessment[]): z.infer<typeof VerdictSchema> {
  if (!criteria.length) return 'insufficient';
  if (criteria.some(c => c.verdict === 'contradicted')) return 'contradicted';
  if (criteria.every(c => c.verdict === 'supported')) return 'supported';
  if (criteria.some(c => c.verdict === 'supported' || c.verdict === 'partial')) return 'partial';
  return 'insufficient';
}
export function summaryOf(items: AssessedRequirement[]): MatchAssessment['summary'] {
  const count = (kind: Requirement['kind']) => {
    const rows = items.filter(i => i.requirement.kind === kind);
    return { total: rows.length, assessed: rows.filter(i => i.assessmentStatus === 'assessed').length,
      supported: rows.filter(i => i.verdict === 'supported').length, partial: rows.filter(i => i.verdict === 'partial').length,
      insufficient: rows.filter(i => i.verdict === 'insufficient').length, contradicted: rows.filter(i => i.verdict === 'contradicted').length,
      unassessed: rows.filter(i => i.assessmentStatus !== 'assessed').length };
  };
  return { requirement: count('requirement'), nice_to_have: count('nice_to_have') };
}
