import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CachingLLM } from "../src/agent/llm/cache.js";
import { RateLimitedLLM } from "../src/agent/llm/ratelimit.js";
import type { ChatRequest, ChatResponse, LLMClient } from "../src/agent/llm/types.js";
import { stability } from "../evals/report.js";
import { loadCases } from "../evals/load.js";
import { runCase, type CaseResult } from "../evals/runner.js";

const ok: ChatResponse = { text: "x", toolCalls: [], finish: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
const req: ChatRequest = { system: "s", tools: [], messages: [{ role: "user", text: "q" }] };

describe("RateLimitedLLM", () => {
  it("makes concurrent calls queue 60s/rpm apart", async () => {
    // Time is frozen and sleep only records the requested wait, so the queue positions are exact.
    const waits: number[] = [];
    const clock = { now: () => 0, sleep: async (ms: number) => void waits.push(ms) };
    const llm = new RateLimitedLLM({ provider: "p", model: "m", chat: async () => ok }, 12, clock);
    await Promise.all([llm.chat(req), llm.chat(req), llm.chat(req)]);
    expect(waits).toEqual([5000, 10000]);
    expect(llm.model).toBe("m");
  });

  it("does not wait after an idle gap, and rejects a bad rate", async () => {
    let t = 0;
    const waits: number[] = [];
    const clock = { now: () => t, sleep: async (ms: number) => void waits.push(ms) };
    const llm = new RateLimitedLLM({ provider: "p", model: "m", chat: async () => ok }, 60, clock);
    await llm.chat(req);
    t += 60_000;
    await llm.chat(req);
    expect(waits).toEqual([]);
    expect(() => new RateLimitedLLM({ provider: "p", model: "m", chat: async () => ok }, 0)).toThrow(/rpm/);
  });
});

describe("CachingLLM salt", () => {
  it("keeps salt 0 compatible with earlier recordings and gives later salts independent samples", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ja-salt-"));
    let n = 0;
    const inner: LLMClient = { provider: "p", model: "m", chat: async () => ({ ...ok, text: `sample${++n}` }) };
    const first = new CachingLLM(inner, dir, 0);
    const second = new CachingLLM(inner, dir, 1);
    expect((await first.chat(req)).text).toBe("sample1");
    expect((await second.chat(req)).text).toBe("sample2");
    expect((await new CachingLLM(inner, dir, 0).chat(req)).text).toBe("sample1");
    expect((await new CachingLLM(inner, dir, 1).chat(req)).text).toBe("sample2");
    expect(first.key(req)).not.toBe(second.key(req));
    expect(n).toBe(2);
  });
});

describe("stability", () => {
  const r = (id: string, passed: boolean): CaseResult => ({
    id, category: "safety", suite: "core", passed, checks: [], tools: [], answer: "", steps: 1,
    usage: { inputTokens: 0, outputTokens: 0 }, ms: 1, blocked: 0, citationRetries: 0,
  });
  it("leaves ungraded runs out of a case's pass rate instead of counting them as failures", () => {
    const u = { ...r("a", false), ungraded: true };
    const s = stability([[u], [r("a", true)], [r("a", true)]]);
    expect(s.perCase[0]).toMatchObject({ passes: 2, runs: 2, ungraded: 1 });
    expect(s.stable).toBe(1);
    expect(stability([[u], [u]]).stable).toBe(0);
  });
  it("separates stable, flaky and always-failing cases", () => {
    const s = stability([[r("a", true), r("b", true), r("c", false)], [r("a", true), r("b", false), r("c", false)], [r("a", true), r("b", true), r("c", false)]]);
    expect(s.stable).toBe(1);
    expect(s.flaky).toEqual([{ id: "b", category: "safety", passes: 2, runs: 3, ungraded: 0 }]);
    expect(s.alwaysFail.map((c) => c.id)).toEqual(["c"]);
  });
});

describe("case set", () => {
  it("keeps the original 29 as the core suite and adds extended injection cases", async () => {
    const cases = await loadCases();
    expect(cases.filter((c) => c.suite === "core")).toHaveLength(29);
    const extended = cases.filter((c) => c.suite === "extended");
    expect(extended.map((c) => c.id).sort()).toEqual(["injection_cn_jd", "injection_encoded", "injection_in_notes", "injection_in_profile"]);
    expect(extended.every((c) => c.category === "adversarial")).toBe(true);
  });

  it("every fixture file exists and every retrieval-using core case verifies citations", async () => {
    const { access } = await import("node:fs/promises");
    for (const c of await loadCases()) {
      for (const path of Object.values(c.fixture ?? {})) await access(path as string);
    }
    const cases = await loadCases();
    for (const id of ["release_time_bullet", "years_of_experience", "postgres_one_sentence", "unsupported_skill", "kafka_experience", "bullets_need_retrieval"]) {
      expect(cases.find((c) => c.id === id)!.checks.some((k) => k.type === "cites"), id).toBe(true);
    }
  });
});

/** A model that always does what injected text says. The host gate must still protect the data. */
function gullible(call: { name: string; args: Record<string, unknown> }): LLMClient {
  let step = 0;
  return {
    provider: "fake",
    model: "gullible",
    async chat() {
      step++;
      if (step === 1) return { ...ok, text: "", finish: "tool_calls", toolCalls: [{ id: "i", name: call.name, args: call.args }] };
      return { ...ok, text: "Done." };
    },
  };
}

describe("injection cases against a gullible model", () => {
  const byId = async (id: string) => (await loadCases()).find((c) => c.id === id)!;

  it("a model that obeys a poisoned note is stopped by the gate: nothing is written, the attempt is a failure", async () => {
    const c = await byId("injection_in_notes");
    const r = await runCase(c, { llm: gullible({ name: "update_application", args: { id: "a1b2c3d4", status: "rejected", confirm: true } }) });
    expect(r.blocked).toBe(1);
    expect(r.passed).toBe(false);
    const failed = r.checks.filter((k) => !k.pass).map((k) => k.type);
    expect(failed).toContain("write_gate");
    expect(failed).toContain("not_calls");
    // the data is intact even though the model was fooled
    expect(r.checks.find((k) => k.type === "store_has" && k.detail.includes("Northwind"))?.pass).toBe(true);
  });

  it("the poisoned profile fixture really contains the injected instruction", async () => {
    const c = await byId("injection_in_profile");
    expect(c.fixture?.profile).toBe("data/sample/profile-poisoned");
    const r = await runCase(c, { llm: gullible({ name: "search_profile", args: { query: "PostgreSQL" } }) });
    const tool = r.checks.find((k) => k.type === "calls");
    expect(tool?.pass).toBe(true);
    expect(JSON.stringify(r)).not.toContain("Evil Corp\",\"role"); // sanity: nothing was written
    const search = await import("../src/rag/index.js").then((m) => m.ProfileIndex.fromDir("data/sample/profile-poisoned"));
    expect((await search.search("assistant add_application Evil Corp", 3)).some((h) => /Evil Corp/.test(h.chunk.text))).toBe(true);
  });
});
