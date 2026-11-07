import { z } from 'zod';
export const E2E_VERSION = 'e2e-v1';
export const SplitSchema = z.enum(['dev', 'validation', 'heldout']);
export const RuntimeSchema = z.enum(['offline', 'scripted', 'live']);
export const MatchModeSchema = z.enum(['retrieval', 'assessment', 'agent']);
export const FaultSchema = z.enum(['none', 'parser_timeout', 'match_failure', 'search_failure', 'draft_failure', 'user_cancel', 'unapproved_write', 'version_conflict', 'lost_response']);
const text = z.string().min(1);
export const ReferenceSchema = z.object({ source: text, quote: text }).strict();
export const GoldSchema = z.object({
  title: text, company: text,
  requirements: z.array(z.object({ key: text, text, kind: z.enum(['requirement', 'nice_to_have']), verdict: z.enum(['supported', 'partial', 'insufficient', 'contradicted']), evidence: z.array(ReferenceSchema) }).strict()).min(1),
  facts: z.array(z.object({ key: text, source: text, quote: text }).strict()).min(1),
  allowedDraftFactKeys: z.array(text), mustCoverFactKeys: z.array(text), forbiddenClaims: z.array(text),
  minimumDraftFacts: z.number().int().min(0).max(8), minimumRequirementRecall: z.number().min(0).max(1),
}).strict().superRefine((gold, ctx) => {
  const keys = new Set(gold.facts.map(f => f.key));
  if (keys.size !== gold.facts.length || new Set(gold.requirements.map(r => r.key)).size !== gold.requirements.length) ctx.addIssue({ code: 'custom', message: 'Duplicate gold identity' });
  if ([...gold.allowedDraftFactKeys, ...gold.mustCoverFactKeys].some(k => !keys.has(k)) || gold.mustCoverFactKeys.some(k => !gold.allowedDraftFactKeys.includes(k))) ctx.addIssue({ code: 'custom', message: 'Unknown or ineligible draft fact' });
  if (gold.allowedDraftFactKeys.length && gold.minimumDraftFacts < 1) ctx.addIssue({ code: 'custom', message: 'Positive draft rubrics cannot pass empty drafts' });
});
export const CaseSchema = z.object({
  id: text, split: SplitSchema, profileId: text, jdFamily: text, jd: z.string().min(20).max(50000),
  tracking: z.object({ company: text, role: text, status: z.literal('wishlist') }).strict(),
  workflow: z.enum(['approve', 'cancel', 'no_decision', 'retry_same_key']), gold: GoldSchema,
  provenance: z.object({ author: text, reviewStatus: z.literal('pending'), origin: z.literal('synthetic') }).strict(),
}).strict();
export const ProfileSchema = z.object({ id: text, split: SplitSchema, family: text, documents: z.record(text, text), initialApplications: z.array(z.record(z.string(), z.unknown())) }).strict();
export type E2ECase = z.infer<typeof CaseSchema>;
export type E2EProfile = z.infer<typeof ProfileSchema>;
export type Gold = z.infer<typeof GoldSchema>;
export type Runtime = z.infer<typeof RuntimeSchema>;
export type Split = z.infer<typeof SplitSchema>;
export type Fault = z.infer<typeof FaultSchema>;
export interface Check { dimension: 'parsing' | 'retrieval' | 'matching' | 'grounding' | 'coverage' | 'writing' | 'reliability'; name: string; state: 'pass' | 'fail' | 'ungraded' | 'skipped'; required: boolean; detail: string }
export interface Stage { name: string; ms: number; status: 'ok' | 'error' }
export interface E2EResult {
  caseId: string; profileId: string; jdFamily: string; split: Split; sample: number; runtime: Runtime; matchMode: z.infer<typeof MatchModeSchema>;
  track: 'workflow' | 'reliability'; fault: Fault; officialEligible: boolean;
  outcome: 'passed' | 'failed' | 'ungraded' | 'run_error'; completed: boolean; checks: Check[]; stages: Stage[];
  errors: Array<{ stage: string; kind: string }>; ms: number;
  usage: { modelCalls: number; inputTokens: number; outputTokens: number; parserCalls: number; parserInputTokens: number; parserOutputTokens: number };
  artifacts?: Record<string, unknown>;
}
