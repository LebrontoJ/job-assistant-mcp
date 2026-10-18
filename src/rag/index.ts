import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { Bm25 } from "./bm25.js";
import { chunkMarkdown, type Chunk } from "./chunk.js";
import { cosine, rrf, type Embedder } from "./embedder.js";
import { tokenize } from "./tokenize.js";

export type SearchMode = "bm25" | "dense" | "hybrid";

export interface IndexOptions {
  /**
   * Hybrid/dense results with no keyword overlap are dropped unless their cosine similarity is at least this.
   * Without it a dense retriever returns the nearest chunks for any query, even unrelated ones.
   */
  minSimilarity?: number;
}

export interface Hit {
  chunk: Chunk;
  score: number;
  /** Cosine similarity to the query when a dense retriever ran. */
  similarity?: number;
  /** Share of the query's distinct terms present in the chunk (0-1). */
  coverage: number;
}

export class ProfileIndex {
  private readonly bm25: Bm25;
  private vectors?: Promise<number[][]>;

  private constructor(
    readonly chunks: Chunk[],
    private readonly embedder?: Embedder,
    private readonly opts: IndexOptions = {},
  ) {
    // The heading is indexed with the body so "Experience > Globex" is searchable.
    this.bm25 = new Bm25(chunks.map((c) => `${c.heading}\n${c.text}`));
  }

  static fromChunks(chunks: Chunk[], embedder?: Embedder, opts?: IndexOptions): ProfileIndex {
    return new ProfileIndex(chunks, embedder, opts);
  }

  static fromMarkdown(files: Record<string, string>, embedder?: Embedder, opts?: IndexOptions): ProfileIndex {
    const chunks = Object.keys(files)
      .sort()
      .flatMap((name) => chunkMarkdown(name, files[name]!));
    return new ProfileIndex(chunks, embedder, opts);
  }

  static async fromDir(dir: string, embedder?: Embedder, opts?: IndexOptions): Promise<ProfileIndex> {
    let names: string[];
    try {
      names = (await readdir(dir, { recursive: true })).filter((n) => n.endsWith(".md"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return new ProfileIndex([], embedder, opts);
      throw err;
    }
    const files: Record<string, string> = {};
    for (const name of names) files[relative(dir, join(dir, name))] = await readFile(join(dir, name), "utf8");
    return ProfileIndex.fromMarkdown(files, embedder, opts);
  }

  get size(): number {
    return this.chunks.length;
  }

  get hybrid(): boolean {
    return this.embedder !== undefined;
  }

  async search(query: string, k = 5, opts: { mode?: SearchMode } = {}): Promise<Hit[]> {
    const mode = opts.mode ?? (this.embedder ? "hybrid" : "bm25");
    if (mode !== "bm25" && !this.embedder) throw new Error(`Search mode "${mode}" needs an embedder`);
    if (!this.chunks.length || !tokenize(query).length) return [];

    const lexical = this.bm25.search(query);
    const lexicalOrder = lexical.map((s) => s.index);
    let order = lexicalOrder;
    let scores = new Map(lexical.map((s) => [s.index, s.score]));
    const sims = new Map<number, number>();

    if (mode !== "bm25") {
      const [q] = await this.embedder!.embed([query], "query");
      const vecs = await this.chunkVectors();
      const dense = vecs
        .map((v, index) => ({ index, score: cosine(q!, v) }))
        .sort((a, b) => b.score - a.score);
      for (const d of dense) sims.set(d.index, d.score);
      const denseOrder = dense.map((d) => d.index);
      if (mode === "dense") {
        order = denseOrder;
        scores = new Map(sims);
      } else {
        scores = rrf([lexicalOrder, denseOrder]);
        order = [...scores.keys()].sort((a, b) => scores.get(b)! - scores.get(a)!);
      }
      const min = this.opts.minSimilarity;
      if (min !== undefined) {
        const lexSet = new Set(lexicalOrder);
        order = order.filter((i) => (mode === "hybrid" && lexSet.has(i)) || (sims.get(i) ?? 0) >= min);
      }
    }

    const terms = new Set(tokenize(query));
    return order.slice(0, k).map((index) => {
      const have = this.bm25.tokensOf(index);
      const covered = [...terms].filter((t) => have.has(t)).length;
      return {
        chunk: this.chunks[index]!,
        score: scores.get(index) ?? 0,
        similarity: sims.get(index),
        coverage: covered / terms.size,
      };
    });
  }

  private chunkVectors(): Promise<number[][]> {
    this.vectors ??= this.embedder!.embed(
      this.chunks.map((c) => `${c.heading}\n${c.text}`),
      "document",
    );
    return this.vectors;
  }
}
