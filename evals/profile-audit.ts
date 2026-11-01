import { z } from "zod";
import { validateClaim } from "../src/agent/grounding.js";
import type { ProfileIndex } from "../src/rag/index.js";
import { evalRetrieval } from "./retrieval.js";
import { RetrievalCaseSchema } from "./types.js";

const Section = z.object({ source: z.string(), heading: z.string() });
export const ProfileAuditSchema = z.object({
  retrieval: z.array(RetrievalCaseSchema).min(1),
  claims: z.array(z.object({
    id: z.string(), query: z.string(), claim: z.string(),
    evidence: Section, expectedSupported: z.boolean(),
  })).min(1),
  content: z.array(z.object({
    id: z.string(), section: Section,
    required: z.array(z.string()).default([]), forbidden: z.array(z.string()).default([]),
  })).min(1),
});
export type ProfileAudit = z.infer<typeof ProfileAuditSchema>;

/** Offline retrieval + source integrity + conservative host checks. No model or semantic judge. */
export async function auditProfile(index: ProfileIndex, suite: ProfileAudit) {
  const matches = (chunk: { source: string; heading: string }, ref: z.infer<typeof Section>) =>
    chunk.source === ref.source && chunk.heading.includes(ref.heading);
  // Reject stale labels instead of allowing absent source sections to look like successful negatives.
  for (const ref of [
    ...suite.retrieval.flatMap(c => c.relevant),
    ...suite.claims.map(c => c.evidence), ...suite.content.map(c => c.section),
  ]) if (!index.chunks.some(c => matches(c, ref))) {
    throw new Error(`Missing audit section: ${ref.source} > ${ref.heading}`);
  }
  for (const cases of [suite.retrieval, suite.claims, suite.content]) {
    if (new Set(cases.map(c => c.id)).size !== cases.length) throw new Error("Duplicate profile audit case id");
  }
  const retrieval = await evalRetrieval(suite.retrieval, index);
  const claims = [];
  for (const c of suite.claims) {
    const hits = await index.search(c.query, 5);
    const evidence = hits.filter(h => matches(h.chunk, c.evidence)).map(h => ({
      id: h.chunk.id, source: h.chunk.source, heading: h.chunk.heading, text: h.chunk.text,
    }));
    const verdict = await validateClaim({ text: c.claim, evidenceIds: evidence.map(e => e.id) }, evidence);
    claims.push({ id: c.id, expectedSupported: c.expectedSupported, supported: verdict.supported,
      reason: evidence.length ? verdict.reason : "expected_evidence_not_retrieved",
      evidenceIds: evidence.map(e => e.id),
      passed: evidence.length > 0 && verdict.supported === c.expectedSupported });
  }
  const content = suite.content.map(c => {
    const text = index.chunks.filter(k => matches(k, c.section)).map(k => k.text).join("\n");
    const missing = c.required.filter(s => !text.includes(s));
    const forbidden = c.forbidden.filter(s => text.includes(s));
    return { id: c.id, passed: !missing.length && !forbidden.length, missing, forbidden };
  });
  return {
    scope: "Offline BM25, source integrity and conservative host rules only; not live answer quality or semantic entailment accuracy.",
    chunks: index.size,
    chunkLengths: { max: Math.max(0, ...index.chunks.map(c => c.text.length)),
      overSoftLimit: index.chunks.filter(c => c.text.length > 400).length },
    retrieval, claims, content,
    passed: retrieval.results.every(r => r.recall[5] === 1) && claims.every(c => c.passed) && content.every(c => c.passed),
  };
}
