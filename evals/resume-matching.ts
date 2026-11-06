import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { ProfileIndex } from '../src/rag/index.js';
import { matchProfile } from '../src/server/match.js';
import { parseJd } from '../src/server/jd.js';
import { runMatching, type MatchingOptions } from '../src/matching/agent.js';
import { VerdictSchema, type MatchMode } from '../src/matching/types.js';
import { percentile } from '../src/agent/trace.js';
export const MatchingCaseSchema = z.object({
  id: z.string(), split: z.enum(['dev', 'heldout']), category: z.string(), requirement: z.string(),
  profile: z.record(z.string(), z.string()), expectedVerdict: VerdictSchema,
  goldEvidence: z.array(z.object({ source: z.string(), quote: z.string() })),
}).strict();
export type MatchingCase = z.infer<typeof MatchingCaseSchema>;
export async function loadMatchingCases(split: 'dev' | 'heldout' = 'dev'): Promise<MatchingCase[]> {
  const rows = (await readFile(new URL(`./matching/${split}.jsonl`, import.meta.url), 'utf8')).trim().split('\n').map(line => MatchingCaseSchema.parse(JSON.parse(line)));
  if (new Set(rows.map(c => c.id)).size !== rows.length) throw new Error('Duplicate matching case id');
  for (const row of rows) {
    if (row.split !== split || row.goldEvidence.some(g => !row.profile[g.source]?.includes(g.quote))) throw new Error('Invalid matching fixture');
  }
  return rows;
}
export interface MatchCaseResult {
  id: string; category: string; mode: MatchMode; expected: z.infer<typeof VerdictSchema>;
  predicted: z.infer<typeof VerdictSchema> | null; completed: boolean; exact: boolean;
  citations: number; goldAlignedCitations: number; modelCalls: number; inputTokens: number; outputTokens: number;
  searches: number; ms: number; error?: string;
}
export async function evaluateMatchingCase(c: MatchingCase, mode: MatchMode, opts: MatchingOptions = {}): Promise<MatchCaseResult> {
  const start = Date.now();
  const base: MatchCaseResult = { id: c.id, category: c.category, mode, expected: c.expectedVerdict, predicted: null, completed: false, exact: false, citations: 0, goldAlignedCitations: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, searches: 0, ms: 0 };
  try {
    const index = ProfileIndex.fromMarkdown(c.profile);
    const jd = { ...parseJd('Synthetic evaluation position'), requirements: [c.requirement] };
    const initial = await matchProfile(jd, index, { includeEvidence: true });
    if (mode === 'retrieval') {
      const label = initial.items[0]!.support;
      // Baseline projection for label comparison only, never presented as a semantic assessment.
      base.predicted = label === 'supported' ? 'supported' : label === 'weak' ? 'partial' : 'insufficient';
      base.completed = true;
    } else {
      const result = await runMatching(initial.evidenceBundle!, { ...opts, mode,
        search: async (query, k, signal) => { signal.throwIfAborted(); return (await index.search(query, k)).map(h => h.chunk); } });
      const item = result.items[0]!;
      if (item.assessmentStatus === 'failed' || item.assessmentStatus === 'timeout' || result.meta.stoppedBecause === 'model_unavailable') base.error = `Assessment unavailable: ${item.assessmentStatus}`;
      base.completed = item.assessmentStatus === 'assessed'; base.predicted = item.verdict;
      Object.assign(base, { modelCalls: result.meta.modelCalls, inputTokens: result.meta.inputTokens, outputTokens: result.meta.outputTokens, searches: result.meta.searches });
      for (const ref of item.criteria.flatMap(c => c.evidence)) {
        base.citations++;
        const source = result.sources.find(s => s.id === ref.sourceId);
        // A labelled evidence-overlap proxy, not a claim of general semantic entailment accuracy.
        if (source && source.text.includes(ref.quote) && c.goldEvidence.some(g => g.source === source.source && (g.quote.includes(ref.quote) || ref.quote.includes(g.quote)))) base.goldAlignedCitations++;
      }
    }
    base.exact = base.completed && base.predicted === c.expectedVerdict;
  } catch (error) { base.error = error instanceof Error ? error.message : String(error); }
  return { ...base, ms: Date.now() - start };
}
export function summarizeMatching(rows: MatchCaseResult[]) {
  const fraction = (numerator: number, denominator: number) => ({ numerator, denominator, rate: denominator ? numerator / denominator : null });
  const positives = rows.filter(r => r.expected === 'supported');
  const negative = rows.filter(r => r.expected !== 'supported');
  const predictedSupport = rows.filter(r => r.predicted === 'supported');
  const citations = rows.reduce((n, r) => n + r.citations, 0);
  return {
    total: rows.length, errors: rows.filter(r => r.error).length,
    completion: fraction(rows.filter(r => r.completed).length, rows.length),
    exact: fraction(rows.filter(r => r.exact).length, rows.length),
    falseSupport: fraction(negative.filter(r => r.predicted === 'supported').length, negative.length),
    supportPrecision: fraction(predictedSupport.filter(r => r.expected === 'supported').length, predictedSupport.length),
    // Includes unfinished positives to expose lost task coverage rather than hide failures.
    falseRejection: fraction(positives.filter(r => r.predicted !== 'supported').length, positives.length),
    goldEvidenceOverlap: fraction(rows.reduce((n, r) => n + r.goldAlignedCitations, 0), citations),
    searches: rows.reduce((n, r) => n + r.searches, 0), modelCalls: rows.reduce((n, r) => n + r.modelCalls, 0),
    inputTokens: rows.reduce((n, r) => n + r.inputTokens, 0), outputTokens: rows.reduce((n, r) => n + r.outputTokens, 0),
    ms: { p50: percentile(rows.map(r => r.ms), 50), p95: percentile(rows.map(r => r.ms), 95) },
  };
}
