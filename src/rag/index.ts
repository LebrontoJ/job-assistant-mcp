import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { Bm25 } from "./bm25.js";
import { chunkMarkdown, type Chunk } from "./chunk.js";
import { cosine, rrf, type Embedder } from "./embedder.js";
import { tokenize } from "./tokenize.js";

export interface Hit {
  chunk: Chunk;
  score: number;
  /** Share of the query's distinct terms present in the chunk (0-1). */
  coverage: number;
}

export class ProfileIndex {
  private readonly bm25: Bm25;
  private vectors?: Promise<number[][]>;

  private constructor(
    readonly chunks: Chunk[],
    private readonly embedder?: Embedder,
  ) {
    // The heading is indexed with the body so "Experience > Globex" is searchable.
    this.bm25 = new Bm25(chunks.map((c) => `${c.heading}\n${c.text}`));
  }

  static fromChunks(chunks: Chunk[], embedder?: Embedder): ProfileIndex {
    return new ProfileIndex(chunks, embedder);
  }

  static fromMarkdown(files: Record<string, string>, embedder?: Embedder): ProfileIndex {
    const chunks = Object.keys(files)
      .sort()
      .flatMap((name) => chunkMarkdown(name, files[name]!));
    return new ProfileIndex(chunks, embedder);
  }

  static async fromDir(dir: string, embedder?: Embedder): Promise<ProfileIndex> {
    let names: string[];
    try {
      names = (await readdir(dir, { recursive: true })).filter((n) => n.endsWith(".md"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return new ProfileIndex([], embedder);
      throw err;
    }
    const files: Record<string, string> = {};
    for (const name of names) files[relative(dir, join(dir, name))] = await readFile(join(dir, name), "utf8");
    return ProfileIndex.fromMarkdown(files, embedder);
  }

  get size(): number {
    return this.chunks.length;
  }

  get hybrid(): boolean {
    return this.embedder !== undefined;
  }

  async search(query: string, k = 5): Promise<Hit[]> {
    if (!this.chunks.length || !tokenize(query).length) return [];
    const lexical = this.bm25.search(query);
    let order = lexical.map((s) => s.index);
    let scores = new Map(lexical.map((s) => [s.index, s.score]));

    if (this.embedder) {
      const [q] = await this.embedder.embed([query]);
      const vecs = await this.chunkVectors();
      const dense = vecs
        .map((v, index) => ({ index, score: cosine(q!, v) }))
        .sort((a, b) => b.score - a.score);
      scores = rrf([order, dense.map((d) => d.index)]);
      order = [...scores.keys()].sort((a, b) => scores.get(b)! - scores.get(a)!);
    }

    const terms = new Set(tokenize(query));
    return order.slice(0, k).map((index) => {
      const have = this.bm25.tokensOf(index);
      const covered = [...terms].filter((t) => have.has(t)).length;
      return { chunk: this.chunks[index]!, score: scores.get(index) ?? 0, coverage: covered / terms.size };
    });
  }

  private chunkVectors(): Promise<number[][]> {
    this.vectors ??= this.embedder!.embed(this.chunks.map((c) => `${c.heading}\n${c.text}`));
    return this.vectors;
  }
}
