import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diffRanks, type RetrievalResult } from "../evals/retrieval.js";
import { formatRetrieval } from "../evals/report.js";
import { CachingEmbedder } from "../src/rag/embed-cache.js";
import type { EmbedKind, Embedder } from "../src/rag/embedder.js";
import { GeminiEmbedder, type EmbedApi } from "../src/rag/gemini-embedder.js";
import { ProfileIndex } from "../src/rag/index.js";

function fakeApi(opts: { merge?: boolean } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const api: EmbedApi = {
    models: {
      async embedContent(params) {
        calls.push(params);
        const n = (params.contents as unknown[]).length;
        // gemini-embedding-2 folds plain inputs into one vector; mimic that failure mode on request
        const count = opts.merge ? 1 : n;
        return { embeddings: Array.from({ length: count }, (_, i) => ({ values: [i + 1, 0, 0] })) };
      },
    },
  };
  return { api, calls };
}

describe("GeminiEmbedder", () => {
  it("001: sends strings with the right task type and dimensionality", async () => {
    const { api, calls } = fakeApi();
    const e = new GeminiEmbedder({ apiKey: "k", client: api });
    expect(e.id).toBe("gemini-gemini-embedding-001-768");
    await e.embed(["a", "b"], "query");
    await e.embed(["c"]);
    expect(calls[0]).toMatchObject({ model: "gemini-embedding-001", contents: ["a", "b"], config: { taskType: "RETRIEVAL_QUERY", outputDimensionality: 768 } });
    expect(calls[1]!.config).toMatchObject({ taskType: "RETRIEVAL_DOCUMENT" });
  });

  it("2: wraps each input in its own Content with a task prefix and no task type", async () => {
    const { api, calls } = fakeApi();
    const e = new GeminiEmbedder({ apiKey: "k", model: "gemini-embedding-2", client: api });
    await e.embed(["alpha", "beta"], "query");
    await e.embed(["gamma"], "document");
    expect(calls[0]!.contents).toEqual([
      { parts: [{ text: "task: search result | query: alpha" }] },
      { parts: [{ text: "task: search result | query: beta" }] },
    ]);
    expect((calls[0]!.config as Record<string, unknown>).taskType).toBeUndefined();
    expect(calls[1]!.contents).toEqual([{ parts: [{ text: "title: none | text: gamma" }] }]);
  });

  it("splits large inputs into batches and keeps order", async () => {
    const { api, calls } = fakeApi();
    const out = await new GeminiEmbedder({ apiKey: "k", batchSize: 2, client: api }).embed(["a", "b", "c", "d", "e"]);
    expect(calls.map((c) => (c.contents as unknown[]).length)).toEqual([2, 2, 1]);
    expect(out).toHaveLength(5);
  });

  it("fails loudly when the API returns fewer vectors than inputs", async () => {
    const { api } = fakeApi({ merge: true });
    await expect(new GeminiEmbedder({ apiKey: "k", client: api }).embed(["a", "b"])).rejects.toThrow(/1 vector\(s\) for 2 input/);
  });
});

describe("CachingEmbedder", () => {
  const counting = () => {
    const seen: string[][] = [];
    const inner: Embedder = {
      id: "fake/model 1",
      async embed(texts: string[], kind?: EmbedKind) {
        seen.push(texts.map((t) => `${kind}:${t}`));
        return texts.map((t) => [t.length, kind === "query" ? 1 : 0]);
      },
    };
    return { inner, seen };
  };

  it("only embeds what it has not seen, per kind, and survives a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ja-emb-"));
    const a = counting();
    const c1 = new CachingEmbedder(a.inner, dir);
    expect(await c1.embed(["x", "yy"], "document")).toEqual([[1, 0], [2, 0]]);
    await c1.embed(["x", "zzz"], "document");
    expect(a.seen).toEqual([["document:x", "document:yy"], ["document:zzz"]]);
    await c1.embed(["x"], "query");
    expect(a.seen.at(-1)).toEqual(["query:x"]);
    expect(c1.hits).toBe(1);

    const b = counting();
    const c2 = new CachingEmbedder(b.inner, dir);
    expect(await c2.embed(["x", "yy", "zzz"], "document")).toEqual([[1, 0], [2, 0], [3, 0]]);
    expect(b.seen).toEqual([]);
    expect((await readdir(dir)).filter((f) => f.endsWith(".json"))).toEqual(["fake_model_1.json"]);
  });
});

describe("ProfileIndex dense and hybrid modes", () => {
  // Axis 0 = "cars", axis 1 = "food", axis 2 = anything else
  const topic: Embedder = {
    async embed(texts) {
      return texts.map((t) => (/car|automobile|engine/i.test(t) ? [1, 0, 0] : /bread|bake|cook/i.test(t) ? [0, 1, 0] : [0, 0, 1]));
    },
  };
  const files = { "a.md": "## Cars\n- I repaired a car engine\n\n## Cooking\n- I bake bread\n\n## Misc\n- I enjoy hiking" };

  it("supports bm25, dense and hybrid explicitly, and rejects dense without an embedder", async () => {
    const idx = ProfileIndex.fromMarkdown(files, topic);
    expect((await idx.search("automobile", 1, { mode: "bm25" }))).toEqual([]);
    expect((await idx.search("automobile", 1, { mode: "dense" }))[0]?.chunk.heading).toBe("Cars");
    expect((await idx.search("automobile", 1, { mode: "hybrid" }))[0]?.chunk.heading).toBe("Cars");
    await expect(ProfileIndex.fromMarkdown(files).search("car", 1, { mode: "dense" })).rejects.toThrow(/needs an embedder/);
  });

  it("minSimilarity keeps unrelated queries from returning the nearest chunk", async () => {
    const open = ProfileIndex.fromMarkdown(files, topic);
    const guarded = ProfileIndex.fromMarkdown(files, topic, { minSimilarity: 0.5 });
    // "quantum" matches no chunk by keyword, and its vector is closest to Misc only by default
    expect((await open.search("quantum physics", 3)).length).toBeGreaterThan(0);
    expect((await guarded.search("quantum physics", 3, { mode: "hybrid" })).map((h) => h.chunk.heading)).toEqual(["Misc"]);
    expect(await guarded.search("automobile", 3, { mode: "dense" })).toHaveLength(1);
  });

  it("keeps keyword matches even when similarity is low, and reports similarity", async () => {
    const idx = ProfileIndex.fromMarkdown(files, topic, { minSimilarity: 0.99 });
    const hits = await idx.search("hiking", 3, { mode: "hybrid" });
    expect(hits[0]?.chunk.heading).toBe("Misc");
    expect(hits[0]?.similarity).toBeCloseTo(1);
  });
});

describe("retrieval comparison helpers", () => {
  const r = (id: string, firstRank: number | null): RetrievalResult => ({ id, query: `q-${id}`, firstRank, recall: {} });

  it("diffRanks separates improvements from regressions and ignores ties", () => {
    const d = diffRanks([r("a", null), r("b", 1), r("c", 2), r("d", 3)], [r("a", 2), r("b", 3), r("c", 2), r("d", 1)]);
    expect(d.improved.map((x) => x.id)).toEqual(["a", "d"]);
    expect(d.regressed.map((x) => x.id)).toEqual(["b"]);
    expect(d.improved[0]).toMatchObject({ from: null, to: 2 });
  });

  it("formatRetrieval renders a mode table and the rank changes", () => {
    const s = (v: number) => ({ cases: 2, recallAt: { 1: v, 3: v, 5: v }, mrr: v, misses: [] as string[] });
    const text = formatRetrieval({
      modes: { bm25: s(0.5), hybrid: s(1) },
      changes: { hybrid: { improved: [{ id: "a", query: "qa", from: null, to: 1 }], regressed: [] } },
      embedder: "gemini-x",
    }).join("\n");
    expect(text).toContain("| bm25 | 0.50 | 0.50 | 0.50 | 0.50 |");
    expect(text).toContain("| hybrid | 1.00");
    expect(text).toContain("a: miss -> #1");
    expect(text).toContain("embedder: gemini-x");
  });
});
