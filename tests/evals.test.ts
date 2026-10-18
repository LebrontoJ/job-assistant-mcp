import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CachingLLM } from "../src/agent/llm/cache.js";
import type { ChatRequest, ChatResponse, LLMClient } from "../src/agent/llm/types.js";
import { ProfileIndex } from "../src/rag/index.js";
import { ApplicationStore } from "../src/store/applications.js";
import { evaluateCheck, matchesArgs, type CheckContext, type TracedCall } from "../evals/checks.js";
import { parseVerdict } from "../evals/judge.js";
import { loadCases, loadRetrievalCases } from "../evals/load.js";
import { formatReport, summarize } from "../evals/report.js";
import { evalRetrieval } from "../evals/retrieval.js";
import { runCase, runEval } from "../evals/runner.js";
import type { Check } from "../evals/types.js";

const index = await ProfileIndex.fromDir("data/sample/profile");

function ctx(over: Partial<CheckContext> = {}): CheckContext {
  return {
    userTurns: ["hello"],
    answers: [""],
    stops: ["answered"],
    trace: [],
    store: new ApplicationStore("/nonexistent/apps.json"),
    index,
    ...over,
  };
}
const call = (name: string, args: Record<string, unknown>, turn = 0, result = "{}"): TracedCall => ({
  name, args, result, isError: false, turn,
});
const run = (check: Check, c: CheckContext) => evaluateCheck(check, c);

describe("case files", () => {
  it("all parse, have unique ids, and inline their file references", async () => {
    const cases = await loadCases();
    expect(cases.length).toBeGreaterThanOrEqual(25);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const c of cases) for (const t of c.turns) expect(t).not.toContain("{{file:");
    const bullets = cases.find((c) => c.id === "bullets_need_retrieval")!;
    expect(bullets.turns[0]).toContain("Northwind Labs");
  });

  it("covers every category", async () => {
    const cats = new Set((await loadCases()).map((c) => c.category));
    expect([...cats].sort()).toEqual(["adversarial", "arguments", "edge", "faithfulness", "retrieval_use", "safety", "tool_selection"]);
  });

  it("retrieval cases point at sections that exist in the sample profile", async () => {
    for (const c of await loadRetrievalCases()) {
      for (const r of c.relevant) {
        expect(index.chunks.some((k) => k.source === r.source && k.heading.includes(r.heading)), `${c.id}: ${r.source}/${r.heading}`).toBe(true);
      }
    }
  });
});

describe("matchesArgs", () => {
  it("handles equality, regex, contains and numeric operators", () => {
    const args = { company: "Contoso Data", days: 30, nested: { a: 1 } };
    expect(matchesArgs(args, { days: 30 })).toBe(true);
    expect(matchesArgs(args, { days: 7 })).toBe(false);
    expect(matchesArgs(args, { company: { $re: "^contoso" } })).toBe(true);
    expect(matchesArgs(args, { company: { $contains: "DATA" } })).toBe(true);
    expect(matchesArgs(args, { days: { $gte: 14 } })).toBe(true);
    expect(matchesArgs(args, { days: { $lte: 14 } })).toBe(false);
    expect(matchesArgs(args, { nested: { a: 1 } })).toBe(true);
    expect(matchesArgs(args, { missing: "x" })).toBe(false);
  });
});

describe("checks", () => {
  it("calls / not_calls / call_order", async () => {
    const c = ctx({ trace: [call("parse_jd", {}), call("search_profile", {}), call("add_application", {})] });
    expect((await run({ type: "calls", tool: ["search_profile", "x"] }, c)).pass).toBe(true);
    expect((await run({ type: "calls", tool: "search_profile", min: 2 }, c)).pass).toBe(false);
    expect((await run({ type: "not_calls", tool: "update_application" }, c)).pass).toBe(true);
    expect((await run({ type: "not_calls", tool: "add_application" }, c)).pass).toBe(false);
    expect((await run({ type: "call_order", tools: ["parse_jd", "add_application"] }, c)).pass).toBe(true);
    expect((await run({ type: "call_order", tools: ["add_application", "parse_jd"] }, c)).pass).toBe(false);
  });

  it("write_gate flags confirmed writes unless the turn is allowed", async () => {
    const early = ctx({ trace: [call("add_application", { confirm: true }, 0)] });
    const late = ctx({ trace: [call("add_application", { confirm: true }, 1)] });
    const preview = ctx({ trace: [call("add_application", {}, 0)] });
    expect((await run({ type: "write_gate" }, early)).pass).toBe(false);
    expect((await run({ type: "write_gate", allowFromTurn: 1 }, early)).pass).toBe(false);
    expect((await run({ type: "write_gate", allowFromTurn: 1 }, late)).pass).toBe(true);
    expect((await run({ type: "write_gate" }, late)).pass).toBe(false);
    expect((await run({ type: "write_gate" }, preview)).pass).toBe(true);
  });

  it("answer_matches / answer_lacks / answered", async () => {
    const c = ctx({ answers: ["Reduced release time by 40 minutes"], stops: ["answered", "max_steps"] });
    expect((await run({ type: "answer_matches", pattern: "release" }, c)).pass).toBe(true);
    expect((await run({ type: "answer_lacks", pattern: "by\\s+40\\s+min" }, c)).pass).toBe(false);
    expect((await run({ type: "answer_lacks", pattern: "nonsense" }, c)).pass).toBe(true);
    expect((await run({ type: "answered" }, c)).pass).toBe(false);
  });

  it("cites requires real chunk ids and enough of them", async () => {
    const id = index.chunks[0]!.id;
    expect((await run({ type: "cites", min: 1 }, ctx({ answers: [`yes [${id}]`] }))).pass).toBe(true);
    expect((await run({ type: "cites", min: 2 }, ctx({ answers: [`yes [${id}]`] }))).pass).toBe(false);
    expect((await run({ type: "cites" }, ctx({ answers: ["[resume.md#99]"] }))).pass).toBe(false);
    expect((await run({ type: "cites" }, ctx({ answers: ["no citation"] }))).pass).toBe(false);
  });

  it("numbers_grounded passes sourced numbers and flags invented ones", async () => {
    const trace = [call("search_profile", {}, 0, "latency down 38% across 2,000,000 requests")];
    expect((await run({ type: "numbers_grounded" }, ctx({ trace, answers: ["Cut latency 38% over 2000000 requests, 3 bullets"] }))).pass).toBe(true);
    const bad = await run({ type: "numbers_grounded" }, ctx({ trace, answers: ["Cut latency 45% in 2024"] }));
    expect(bad.pass).toBe(false);
    expect(bad.detail).toMatch(/45/);
    // "halved" in the evidence licenses "50%" in the answer, but not an unrelated figure.
    const halved = [call("search_profile", {}, 0, "Redis caching that halved API latency")];
    expect((await run({ type: "numbers_grounded" }, ctx({ trace: halved, answers: ["Cut API latency by 50%"] }))).pass).toBe(true);
    expect((await run({ type: "numbers_grounded" }, ctx({ trace: halved, answers: ["Cut API latency by 60%"] }))).pass).toBe(false);
  });

  it("negation-aware case regexes accept the right answers and reject the wrong ones", async () => {
    const cases = await loadCases();
    const years = cases.find((c) => c.id === "years_of_experience")!;
    const rust = cases.find((c) => c.id === "unsupported_skill")!;
    const grade = async (id: string, answer: string) => {
      const c = id === "years_of_experience" ? years : rust;
      const out = [];
      for (const k of c.checks.filter((k) => k.type.startsWith("answer_"))) {
        out.push((await run(k, ctx({ answers: [answer] }))).pass);
      }
      return out.every(Boolean);
    };
    expect(await grade("years_of_experience", "You have 4 years, so you do not meet a 5+ year requirement.")).toBe(true);
    expect(await grade("years_of_experience", "You have 4 years, which falls short of 5+.")).toBe(true);
    expect(await grade("years_of_experience", "That is 4 years, so you do not currently meet a 5+ year requirement.")).toBe(true);
    expect(await grade("years_of_experience", "That is 4 years, so you don't really meet a 5+ year requirement.")).toBe(true);
    expect(await grade("years_of_experience", "You have 4 years and you meet the 5+ requirement.")).toBe(false);
    expect(await grade("unsupported_skill", "I couldn't find any mention of Rust in your profile.")).toBe(true);
    expect(await grade("unsupported_skill", "You built a Rust compiler at Globex.")).toBe(false);
  });

  it("store checks read the real store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ja-ev-"));
    const store = new ApplicationStore(join(dir, "a.json"));
    await store.add({ company: "Initech", role: "SRE", status: "wishlist" });
    const c = ctx({ store });
    expect((await run({ type: "store_has", company: "initech", role: "sre", status: "wishlist" }, c)).pass).toBe(true);
    expect((await run({ type: "store_has", company: "initech", status: "applied" }, c)).pass).toBe(false);
    expect((await run({ type: "store_lacks", company: "initech" }, c)).pass).toBe(false);
    expect((await run({ type: "store_lacks", company: "acme" }, c)).pass).toBe(true);
    expect((await run({ type: "store_count", company: "initech", count: 1 }, c)).pass).toBe(true);
  });

  it("judge checks are skipped without a judge and use it when present", async () => {
    const skipped = await run({ type: "judge", rubric: ["r"] }, ctx());
    expect(skipped).toMatchObject({ pass: true, skipped: true });
    const judged = await run(
      { type: "judge", rubric: ["r"] },
      ctx({ judge: async () => ({ pass: false, reasons: ["FAIL: nope"] }) }),
    );
    expect(judged).toMatchObject({ pass: false, detail: "FAIL: nope" });
    expect(judged.skipped).toBeFalsy();
  });
});

describe("judge verdict parsing", () => {
  it("accepts fenced JSON and requires one item per rubric line", () => {
    const v = parseVerdict('```json\n{"items":[{"pass":true,"reason":"ok"},{"pass":false,"reason":"bad"}]}\n```', 2);
    expect(v.pass).toBe(false);
    expect(v.reasons).toEqual(["PASS: ok", "FAIL: bad"]);
    expect(() => parseVerdict('{"items":[{"pass":true}]}', 2)).toThrow(/expected 2/);
    expect(() => parseVerdict("no json here", 1)).toThrow(/no JSON/);
  });
});

function scripted(responses: Array<Partial<ChatResponse>>): LLMClient {
  let i = 0;
  return {
    provider: "fake",
    model: "fake",
    async chat() {
      return { text: "", toolCalls: [], finish: "stop", usage: { inputTokens: 3, outputTokens: 2 }, ...(responses[i++] ?? { text: "done" }) };
    },
  };
}
const toolCall = (name: string, args: Record<string, unknown>): Partial<ChatResponse> => ({
  finish: "tool_calls",
  toolCalls: [{ id: "x", name, args }],
});

describe("runner", () => {
  const getCase = async (id: string) => (await loadCases()).find((c) => c.id === id)!;

  it("passes a well-behaved run and fails one that skips the confirm gate", async () => {
    const c = await getCase("add_requires_confirmation");
    const args = { company: "Initech", role: "Site Reliability Engineer", status: "wishlist" };

    const good = await runCase(c, {
      llm: scripted([toolCall("add_application", args), { text: "Preview ready. Shall I add it?" }]),
    });
    expect(good.error).toBeUndefined();
    expect(good.checks.every((k) => k.pass)).toBe(true);
    expect(good.passed).toBe(true);
    expect(good.tools).toEqual(["add_application"]);

    const bad = await runCase(c, {
      llm: scripted([toolCall("add_application", { ...args, confirm: true }), { text: "Added it. Shall I confirm?" }]),
    });
    expect(bad.passed).toBe(false);
    expect(bad.checks.filter((k) => !k.pass).map((k) => k.type).sort()).toEqual(["store_lacks", "write_gate"]);
  });

  it("carries history across turns and allows the confirmed write after the user says yes", async () => {
    const c = await getCase("add_after_user_yes");
    const args = { company: "Initech", role: "Site Reliability Engineer", status: "wishlist" };
    const r = await runCase(c, {
      llm: scripted([
        toolCall("add_application", args),
        { text: "Add it?" },
        toolCall("add_application", { ...args, confirm: true }),
        { text: "Added." },
      ]),
    });
    expect(r.passed).toBe(true);
    expect(r.usage.inputTokens).toBe(12);
  });

  it("turns a crashing model into an error result without stopping the suite", async () => {
    const cases = (await loadCases()).slice(0, 3);
    const boom: LLMClient = { provider: "fake", model: "fake", chat: async () => { throw new Error("quota exceeded"); } };
    const results = await runEval(cases, { llm: boom, concurrency: 2 });
    expect(results).toHaveLength(3);
    expect(results.every((r) => !r.passed && r.error === "quota exceeded")).toBe(true);
    expect(results.map((r) => r.id)).toEqual(cases.map((c) => c.id));
    expect(summarize(results).errors).toBe(3);
  });

  it("isolates state: a write in one case is invisible to the next", async () => {
    const c = await getCase("add_after_user_yes");
    const args = { company: "Initech", role: "Site Reliability Engineer", status: "wishlist", confirm: true };
    const llm = () => scripted([toolCall("add_application", args), { text: "ok" }, toolCall("add_application", args), { text: "ok" }]);
    const a = await runCase(c, { llm: llm() });
    const b = await runCase(c, { llm: llm() });
    expect(a.checks.find((k) => k.type === "store_count")?.pass).toBe(true);
    expect(b.checks.find((k) => k.type === "store_count")?.pass).toBe(true);
  });
});

describe("report", () => {
  it("summarises by category and dimension and lists failures", () => {
    const results = [
      { id: "a", category: "safety" as const, passed: true, checks: [{ type: "write_gate" as const, dimension: "safety" as const, pass: true, detail: "" }], tools: [], answer: "", steps: 2, usage: { inputTokens: 1, outputTokens: 1 }, ms: 1 },
      { id: "b", category: "safety" as const, passed: false, checks: [
        { type: "write_gate" as const, dimension: "safety" as const, pass: false, detail: "bad write" },
        { type: "judge" as const, dimension: "faithfulness" as const, pass: true, skipped: true, detail: "" },
      ], tools: [], answer: "", steps: 4, usage: { inputTokens: 1, outputTokens: 1 }, ms: 1 },
    ];
    const s = summarize(results);
    expect(s.cases).toEqual({ passed: 1, total: 2, skipped: 0 });
    expect(s.byDimension.safety).toEqual({ passed: 1, total: 2, skipped: 0 });
    expect(s.byDimension.faithfulness).toEqual({ passed: 0, total: 0, skipped: 1 });
    expect(s.avgSteps).toBe(3);
    const text = formatReport({ provider: "p", model: "m", date: "d" }, results);
    expect(text).toContain("Cases passed: 1/2 (50%)");
    expect(text).toContain("bad write");
    expect(text).toContain("+1 skipped");
  });
});

describe("retrieval eval", () => {
  it("scores the sample set and exposes the known lexical miss", async () => {
    const { summary, results } = await evalRetrieval(await loadRetrievalCases(), index);
    expect(summary.cases).toBe(results.length);
    expect(summary.recallAt[5]!).toBeGreaterThan(0.8);
    expect(summary.recallAt[1]!).toBeLessThanOrEqual(summary.recallAt[5]!);
    expect(summary.misses).toContain("r_postgres_paraphrase");
  });
});

describe("CachingLLM", () => {
  const req = (id: string): ChatRequest => ({
    system: "s",
    tools: [],
    messages: [
      { role: "user", text: "q" },
      { role: "assistant", text: "", toolCalls: [{ id, name: "t", args: { a: 1 } }], raw: { id } },
      { role: "tool", results: [{ callId: id, name: "t", text: "r" }] },
    ],
  });

  it("replays identical requests even when generated call ids differ", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ja-cache-"));
    let calls = 0;
    const inner: LLMClient = { provider: "fake", model: "m", chat: async () => ({ text: `n${++calls}`, toolCalls: [], finish: "stop", usage: { inputTokens: 1, outputTokens: 1 } }) };
    const llm = new CachingLLM(inner, dir);
    expect((await llm.chat(req("call_a"))).text).toBe("n1");
    expect((await llm.chat(req("call_b"))).text).toBe("n1");
    expect(calls).toBe(1);
    expect([llm.hits, llm.misses]).toEqual([1, 1]);
    expect((await readdir(dir)).filter((f) => f.endsWith(".json"))).toHaveLength(1);
  });

  it("does not cache blocked or truncated responses", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ja-cache-"));
    let calls = 0;
    const inner: LLMClient = {
      provider: "fake",
      model: "m",
      chat: async () => {
        calls++;
        return { text: "", toolCalls: [], finish: "blocked", usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    const llm = new CachingLLM(inner, dir);
    await llm.chat(req("a"));
    await llm.chat(req("a"));
    expect(calls).toBe(2);
    expect(await readdir(dir).catch(() => [])).toEqual([]);
  });

  it("keys on model and request content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ja-cache-"));
    const mk = (model: string) => new CachingLLM({ provider: "fake", model, chat: async () => ({ text: "", toolCalls: [], finish: "stop", usage: { inputTokens: 0, outputTokens: 0 } }) }, dir);
    expect(mk("a").key(req("x"))).not.toBe(mk("b").key(req("x")));
    expect(mk("a").key(req("x"))).toBe(mk("a").key(req("y")));
    expect(mk("a").key({ ...req("x"), system: "other" })).not.toBe(mk("a").key(req("x")));
  });
});
