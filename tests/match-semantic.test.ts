import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { bySplit, collectSignals, score, sweep } from "../evals/matching.js";
import { loadMatchCases } from "../evals/load.js";
import { createEmbedding, DEFAULT_MATCH_SEMANTIC } from "../src/rag/factory.js";
import type { Embedder } from "../src/rag/embedder.js";
import { ProfileIndex } from "../src/rag/index.js";
import { decideSupport, isQuantitative, matchProfile, type SupportSignals } from "../src/server/match.js";
import { parseJd, type ParsedJd } from "../src/server/jd.js";
import { createServer } from "../src/server/server.js";
import { ApplicationStore } from "../src/store/applications.js";
import { textOf } from "./helpers.js";

const sig = (over: Partial<SupportSignals> = {}): SupportSignals => ({ coverage: 0, matched: 0, terms: 3, quantitative: false, ...over });
const SEM = { high: 0.75, low: 0.65 };

describe("decideSupport", () => {
  it("keyword rules: coverage thresholds", () => {
    expect(decideSupport(sig({ coverage: 0.67, matched: 2 })).support).toBe("supported");
    expect(decideSupport(sig({ coverage: 0.33, matched: 1 })).support).toBe("weak");
    expect(decideSupport(sig({ coverage: 0.1, matched: 0 })).support).toBe("no_evidence");
  });

  it("one shared word out of two is not enough for 'supported', but a single-word item can be", () => {
    expect(decideSupport(sig({ coverage: 0.5, matched: 1, terms: 2 })).support).toBe("weak");
    expect(decideSupport(sig({ coverage: 1, matched: 1, terms: 1 })).support).toBe("supported");
    expect(decideSupport(sig({ coverage: 0.5, matched: 2, terms: 4 })).support).toBe("supported");
  });

  it("similarity alone can reach 'weak' but never 'supported'", () => {
    expect(decideSupport(sig({ coverage: 0, similarity: 0.9 }), SEM).support).toBe("weak");
    expect(decideSupport(sig({ coverage: 0, similarity: 0.6 }), SEM).support).toBe("no_evidence");
    expect(decideSupport(sig({ coverage: 0, matched: 0, similarity: 0.99 }), SEM).support).not.toBe("supported");
  });

  it("some word overlap plus high similarity lifts 'weak' to 'supported'", () => {
    const base = sig({ coverage: 0.33, matched: 2, terms: 6 });
    expect(decideSupport(base, SEM).support).toBe("weak");
    expect(decideSupport({ ...base, similarity: 0.8 }, SEM).support).toBe("supported");
    expect(decideSupport({ ...base, similarity: 0.7 }, SEM).support).toBe("weak");
    // but not if only one word matched
    expect(decideSupport({ ...base, matched: 1, similarity: 0.9 }, SEM).support).toBe("weak");
  });

  it("a quantity is never 'supported', whatever the signals say", () => {
    const r = decideSupport(sig({ coverage: 1, matched: 3, similarity: 0.95, quantitative: true }), SEM);
    expect(r.support).toBe("weak");
    expect(r.note).toMatch(/quantity/);
  });

  it("ignores similarity when no thresholds are given", () => {
    expect(decideSupport(sig({ coverage: 0, similarity: 0.99 })).support).toBe("no_evidence");
  });

  it("detects quantities", () => {
    for (const t of ["5+ years of backend experience", "at least 3 languages", "2 yrs Python", "10+ engineers"]) expect(isQuantitative(t), t).toBe(true);
    for (const t of ["Strong knowledge of PostgreSQL", "Experience with Python 3", "Led an incident"]) expect(isQuantitative(t), t).toBe(false);
  });
});

/** Topic-vector embedder: "ml" -> axis 0, "cars" -> axis 1, anything else -> axis 2. */
const topics: Embedder = {
  async embed(texts) {
    return texts.map((t) => (/model|ml|machine learning|rag|retrieval/i.test(t) ? [1, 0, 0] : /car|engine/i.test(t) ? [0, 1, 0] : [0, 0, 1]));
  },
};
const jd = (requirements: string[], niceToHave: string[] = []): ParsedJd => ({
  title: "t", company: null, location: null, workMode: null, minYearsExperience: null,
  responsibilities: [], requirements, niceToHave, skills: [],
});
const files = { "p.md": "## Work\n- Built a RAG assistant with embeddings\n\n## Hobbies\n- I repair car engines" };

describe("matchProfile with embeddings", () => {
  it("surfaces a related passage found by meaning only, labelled as such, capped at weak", async () => {
    const idx = ProfileIndex.fromMarkdown(files, topics);
    const r = await matchProfile(jd(["Experience deploying machine learning models"]), idx, { semantic: { high: 0.75, low: 0.65 } });
    const item = r.items[0]!;
    expect(item.support).toBe("weak");
    expect(item.similarity).toBeCloseTo(1);
    expect(item.evidence[0]).toMatchObject({ chunkId: "p.md#0", matchedBy: "semantic" });
    expect(r.note).toMatch(/Similarity alone never/);
  });

  it("without thresholds the same requirement finds nothing", async () => {
    const idx = ProfileIndex.fromMarkdown(files, topics);
    const r = await matchProfile(jd(["Experience deploying machine learning models"]), idx);
    expect(r.items[0]).toMatchObject({ support: "no_evidence", evidence: [] });
  });

  it("thresholds are ignored on a keyword-only index, so behaviour is unchanged", async () => {
    const idx = ProfileIndex.fromMarkdown(files);
    const r = await matchProfile(jd(["Experience deploying machine learning models"]), idx, { semantic: { high: 0.1, low: 0.1 } });
    expect(r.items[0]!.support).toBe("no_evidence");
    expect(r.items[0]!.similarity).toBeUndefined();
  });

  it("an unrelated requirement stays at no_evidence even with a dense retriever", async () => {
    const idx = ProfileIndex.fromMarkdown(files, topics, { minSimilarity: 0.55 });
    const r = await matchProfile(jd(["Fluent in Haskell"]), idx, { semantic: { high: 0.75, low: 0.65 } });
    expect(r.items[0]!.support).toBe("no_evidence");
  });

  it("marks keyword+semantic evidence when both signals agree, and caps a quantity at weak with a note", async () => {
    const idx = ProfileIndex.fromMarkdown(files, topics);
    const r = await matchProfile(jd(["Built a RAG assistant", "5+ years building RAG assistants"]), idx, { semantic: { high: 0.75, low: 0.65 } });
    expect(r.items[0]).toMatchObject({ support: "supported" });
    expect(r.items[0]!.evidence[0]!.matchedBy).toBe("keyword+semantic");
    expect(r.items[1]).toMatchObject({ support: "weak" });
    expect(r.items[1]!.note).toMatch(/quantity/);
  });
});

describe("match_resume through the server", () => {
  it("passes the thresholds from the server options", async () => {
    const idx = ProfileIndex.fromMarkdown(files, topics);
    const make = async (match?: { semantic: { high: number; low: number } }) => {
      const server = createServer(new ApplicationStore("/nonexistent/a.json"), idx, { match });
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "t", version: "0" });
      await Promise.all([server.connect(a), client.connect(b)]);
      return client;
    };
    const text = "Role\n\nRequirements:\n- Experience deploying machine learning models\n- Fluent in Haskell and friends\n";
    const on = JSON.parse(textOf(await (await make({ semantic: { high: 0.75, low: 0.65 } })).callTool({ name: "match_resume", arguments: { jd_text: text } })));
    const off = JSON.parse(textOf(await (await make()).callTool({ name: "match_resume", arguments: { jd_text: text } })));
    expect(on.items[0].support).toBe("weak");
    expect(off.items[0].support).toBe("no_evidence");
    expect(on.summary.requirements.weak).toBe(1);
    expect(parseJd(text).requirements).toHaveLength(2);
  });
});

describe("labelled match set", () => {
  it("is well formed, balanced across splits, and every item has a unique id", async () => {
    const cases = await loadMatchCases();
    expect(cases).toHaveLength(28);
    expect(new Set(cases.map((c) => c.id)).size).toBe(28);
    for (const split of ["dev", "test"] as const) {
      for (const truth of ["supported", "weak", "no_evidence"] as const) {
        const n = cases.filter((c) => c.split === split && c.truth === truth).length;
        expect(n, `${split}/${truth}`).toBeGreaterThan(0);
      }
    }
    expect(cases.filter((c) => c.split === "dev")).toHaveLength(14);
  });

  it("keyword-only matching never calls an unsupported requirement 'supported' on the sample profile", async () => {
    const idx = await ProfileIndex.fromDir("data/sample/profile");
    const scored = score(await collectSignals(await loadMatchCases(), idx));
    expect(bySplit(scored).all.falseSupported).toBe(0);
  });

  it("the sweep only evaluates the dev split and respects low <= high", async () => {
    const idx = await ProfileIndex.fromDir("data/sample/profile", topics);
    const rows = sweep(await collectSignals(await loadMatchCases(), idx), 0.5, 0.6, 0.05);
    expect(rows.every((r) => r.low <= r.high && r.dev.n === 14)).toBe(true);
  });
});

describe("factory defaults", () => {
  it("default model gets the measured match thresholds; other settings get none; env overrides", () => {
    const base = { EMBEDDINGS: "gemini", GEMINI_API_KEY: "k" };
    expect(createEmbedding(base).matchSemantic).toEqual(DEFAULT_MATCH_SEMANTIC);
    expect(createEmbedding({ ...base, EMBEDDING_MODEL: "gemini-embedding-2" }).matchSemantic).toBeUndefined();
    expect(createEmbedding({ ...base, EMBEDDING_MATCH_HIGH: "0.8", EMBEDDING_MATCH_LOW: "0.7" }).matchSemantic).toEqual({ high: 0.8, low: 0.7 });
    expect(createEmbedding({}).matchSemantic).toBeUndefined();
  });
});
