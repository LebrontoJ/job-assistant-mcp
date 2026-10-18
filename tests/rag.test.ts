import { describe, expect, it } from "vitest";
import { Bm25 } from "../src/rag/bm25.js";
import { chunkMarkdown } from "../src/rag/chunk.js";
import { cosine, rrf, type Embedder } from "../src/rag/embedder.js";
import { ProfileIndex } from "../src/rag/index.js";
import { tokenize } from "../src/rag/tokenize.js";

describe("tokenize", () => {
  it("keeps technical tokens, drops stopwords, normalises plurals", () => {
    expect(tokenize("Experience with C++, CI/CD and Node.js services.")).toEqual(["c++", "ci/cd", "ci", "cd", "node.js", "service"]);
  });
  it("indexes both halves of slash compounds", () => {
    expect(tokenize("Python/FastAPI")).toEqual(["python/fastapi", "python", "fastapi"]);
  });
  it("makes bigrams for Han text", () => {
    expect(tokenize("后端开发")).toEqual(["后端", "端开", "开发"]);
  });
});

describe("chunkMarkdown", () => {
  const md = "# Me\n\n## Experience\n### Acme\n- Built X.\n- Built Y.\n\n## Skills\nGo, SQL\n";

  it("carries the heading path and splits per section", () => {
    const c = chunkMarkdown("r.md", md);
    expect(c.map((x) => x.heading)).toEqual(["Me > Experience > Acme", "Me > Skills"]);
    expect(c[0]?.text).toBe("Built X.\nBuilt Y.");
    expect(c.map((x) => x.id)).toEqual(["r.md#0", "r.md#1"]);
  });

  it("packs bullets up to the size limit without mixing sections", () => {
    const body = Array.from({ length: 6 }, (_, i) => `- bullet number ${i} ${"x".repeat(30)}`).join("\n");
    const c = chunkMarkdown("r.md", `## A\n${body}\n## B\n- other`, 100);
    expect(c.filter((x) => x.heading === "A").length).toBeGreaterThan(1);
    expect(c.every((x) => x.text.length <= 100 || !x.text.includes("\n"))).toBe(true);
    expect(c.at(-1)).toMatchObject({ heading: "B", text: "other" });
  });

  it("ignores headings inside code fences", () => {
    const c = chunkMarkdown("r.md", "## A\n```\n# not a heading\n```\n");
    expect(c.map((x) => x.heading)).toEqual(["A"]);
  });
});

describe("Bm25", () => {
  const bm = new Bm25(["postgres query tuning", "kubernetes deployment", "postgres and redis caching"]);
  it("ranks by relevance and drops zero-score docs", () => {
    expect(bm.search("postgres redis").map((s) => s.index)).toEqual([2, 0]);
    expect(bm.search("haskell")).toEqual([]);
  });
});

describe("fusion helpers", () => {
  it("rrf rewards agreement between rankings", () => {
    const f = rrf([[1, 2], [3, 2]]);
    expect(f.get(2)! > f.get(1)!).toBe(true);
  });
  it("cosine", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe("ProfileIndex", () => {
  it("finds the right passage from the sample profile and reports coverage", async () => {
    const idx = await ProfileIndex.fromDir("data/sample/profile");
    expect(idx.size).toBeGreaterThan(3);
    const [top] = await idx.search("PostgreSQL query latency", 3);
    expect(top?.chunk.source).toBe("resume.md");
    expect(top?.chunk.text).toMatch(/PostgreSQL/);
    expect(top?.coverage).toBeGreaterThan(0.5);
  });

  it("returns nothing for unrelated or empty queries and tolerates a missing dir", async () => {
    const idx = await ProfileIndex.fromDir("data/sample/profile");
    expect(await idx.search("haskell monads", 3)).toEqual([]);
    expect(await idx.search("the of", 3)).toEqual([]);
    expect((await ProfileIndex.fromDir("data/nope")).size).toBe(0);
  });

  it("searches Chinese text", async () => {
    const idx = ProfileIndex.fromMarkdown({ "cn.md": "## 经历\n- 负责后端服务的性能优化\n\n## 爱好\n- 摄影" });
    const [top] = await idx.search("性能优化", 1);
    expect(top?.chunk.heading).toBe("经历");
  });

  it("fuses dense results when an embedder is present", async () => {
    // BM25 alone cannot link "automobile" to "car"; the fake embedder can.
    const fake: Embedder = {
      embed: async (texts) => texts.map((t) => (/car|automobile/i.test(t) ? [1, 0] : [0, 1])),
    };
    const files = { "a.md": "## Cars\n- I repaired a car engine\n\n## Cooking\n- I bake bread" };
    const lexical = ProfileIndex.fromMarkdown(files);
    expect(await lexical.search("automobile", 2)).toEqual([]);
    const hybrid = ProfileIndex.fromMarkdown(files, fake);
    expect(hybrid.hybrid).toBe(true);
    expect((await hybrid.search("automobile", 1))[0]?.chunk.heading).toBe("Cars");
  });
});
