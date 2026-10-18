import type { ProfileIndex } from "../src/rag/index.js";
import type { RetrievalCase } from "./types.js";

export interface RetrievalResult {
  id: string;
  query: string;
  /** 1-based rank of the first relevant chunk, or null if none in the top results. */
  firstRank: number | null;
  recall: Record<number, number>;
}
export interface RetrievalSummary {
  cases: number;
  recallAt: Record<number, number>;
  mrr: number;
  misses: string[];
}

export const KS = [1, 3, 5];

export async function evalRetrieval(cases: RetrievalCase[], index: ProfileIndex): Promise<{ results: RetrievalResult[]; summary: RetrievalSummary }> {
  const results: RetrievalResult[] = [];
  for (const c of cases) {
    const hits = await index.search(c.query, Math.max(...KS));
    const isRelevant = (i: number) =>
      c.relevant.some((r) => hits[i]!.chunk.source === r.source && hits[i]!.chunk.heading.includes(r.heading));
    const rank = hits.findIndex((_, i) => isRelevant(i));
    const recall: Record<number, number> = {};
    for (const k of KS) {
      // fraction of the relevant sections that appear in the top k
      const found = c.relevant.filter((r) =>
        hits.slice(0, k).some((h) => h.chunk.source === r.source && h.chunk.heading.includes(r.heading)),
      ).length;
      recall[k] = found / c.relevant.length;
    }
    results.push({ id: c.id, query: c.query, firstRank: rank === -1 ? null : rank + 1, recall });
  }
  const n = results.length || 1;
  return {
    results,
    summary: {
      cases: results.length,
      recallAt: Object.fromEntries(KS.map((k) => [k, results.reduce((a, r) => a + r.recall[k]!, 0) / n])),
      mrr: results.reduce((a, r) => a + (r.firstRank ? 1 / r.firstRank : 0), 0) / n,
      misses: results.filter((r) => r.firstRank === null).map((r) => r.id),
    },
  };
}
