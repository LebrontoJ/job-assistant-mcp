import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EmbedKind, Embedder } from "./embedder.js";

/** Remembers vectors on disk, so indexing the same profile twice costs no API quota. */
export class CachingEmbedder implements Embedder {
  hits = 0;
  misses = 0;
  private store?: Promise<Record<string, number[]>>;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly inner: Embedder,
    private readonly dir: string,
  ) {}

  get id() {
    return this.inner.id;
  }

  private get file() {
    return join(this.dir, `${(this.inner.id ?? "embedder").replace(/[^\w.-]/g, "_")}.json`);
  }

  private load(): Promise<Record<string, number[]>> {
    this.store ??= readFile(this.file, "utf8").then(
      (t) => JSON.parse(t) as Record<string, number[]>,
      () => ({}),
    );
    return this.store;
  }

  private key(text: string, kind: EmbedKind) {
    return createHash("sha256").update(`${kind}\n${text}`).digest("hex");
  }

  async embed(texts: string[], kind: EmbedKind = "document"): Promise<number[][]> {
    const cache = await this.load();
    const missing = [...new Set(texts.filter((t) => !cache[this.key(t, kind)]))];
    this.hits += texts.length - texts.filter((t) => missing.includes(t)).length;
    if (missing.length) {
      this.misses += missing.length;
      const fresh = await this.inner.embed(missing, kind);
      missing.forEach((t, i) => (cache[this.key(t, kind)] = fresh[i]!));
      this.writes = this.writes.then(async () => {
        await mkdir(this.dir, { recursive: true });
        const tmp = `${this.file}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(cache), "utf8");
        await rename(tmp, this.file);
      });
      await this.writes;
    }
    return texts.map((t) => cache[this.key(t, kind)]!);
  }
}
