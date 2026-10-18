export type EmbedKind = "query" | "document";

export interface Embedder {
  /** Stable identifier (provider, model, settings), used to key on-disk caches. */
  readonly id?: string;
  /** One vector per input, in order. `kind` lets models that distinguish queries from documents do so. */
  embed(texts: string[], kind?: EmbedKind): Promise<number[][]>;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! ** 2;
    nb += b[i]! ** 2;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Reciprocal rank fusion: combines rankings without needing comparable score scales. */
export function rrf(rankings: number[][], k = 60): Map<number, number> {
  const fused = new Map<number, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, rank) => fused.set(id, (fused.get(id) ?? 0) + 1 / (k + rank + 1)));
  }
  return fused;
}
