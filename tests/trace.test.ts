import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgent } from "../src/agent/loop.js";
import { AnthropicClient, type AnthropicLike, type WireResponse } from "../src/agent/llm/anthropic.js";
import { withRetry } from "../src/agent/llm/retry.js";
import { TimedLLM } from "../src/agent/llm/timed.js";
import { CachingLLM } from "../src/agent/llm/cache.js";
import type { ChatRequest, ChatResponse, LLMClient } from "../src/agent/llm/types.js";
import { JsonlTracer, MemoryTracer, clip, formatStats, formatTrace, multiTracer, parseTrace, percentile, summarizeEvents, type TraceEvent } from "../src/agent/trace.js";
import { loadCases } from "../evals/load.js";
import { runCase } from "../evals/runner.js";
import { formatReport } from "../evals/report.js";
import { connectedPair } from "./helpers.js";

function scripted(responses: Array<Partial<ChatResponse>>): LLMClient {
  let i = 0;
  return {
    provider: "fake",
    model: "fake-1",
    async chat() {
      return { text: "", toolCalls: [], finish: "stop", usage: { inputTokens: 10, outputTokens: 2 }, ...(responses[i++] ?? { text: "done" }) };
    },
  };
}
const call = (name: string, args: Record<string, unknown>, latencyMs = 120): Partial<ChatResponse> => ({
  finish: "tool_calls", latencyMs, toolCalls: [{ id: "c", name, args }],
});
const init = { company: "Initech", role: "Site Reliability Engineer", status: "wishlist" };

describe("agent run tracing", () => {
  it("emits run_start, model and tool calls in order, then run_end with totals", async () => {
    const { client } = await connectedPair();
    const t = new MemoryTracer();
    await runAgent(scripted([call("list_followups", { days: 7 }), { text: "Two due.", latencyMs: 80 }]), client, "What is due?", { tracer: t, runId: "r1" });
    expect(t.events.map((e) => e.type)).toEqual(["run_start", "llm_call", "tool_call", "llm_call", "run_end"]);
    expect(t.events.every((e) => e.runId === "r1")).toBe(true);
    const [start, m1, tool, m2, end] = t.events as [TraceEvent, any, any, any, any];
    expect(start).toMatchObject({ provider: "fake", model: "fake-1", user: "What is due?" });
    expect(m1).toMatchObject({ step: 1, ms: 120, inputTokens: 10, finish: "tool_calls", toolCalls: ["list_followups"] });
    expect(tool).toMatchObject({ step: 1, name: "list_followups", isError: false });
    expect(tool.ms).toBeGreaterThanOrEqual(0);
    expect(tool.result).toContain("Contoso");
    expect(m2).toMatchObject({ step: 2, ms: 80, finish: "stop" });
    expect(end).toMatchObject({ stoppedBecause: "answered", steps: 2, inputTokens: 20, outputTokens: 4, answerChars: 8 });
  });

  it("records guard actions: a blocked write and a citation retry", async () => {
    const { client } = await connectedPair();
    const t = new MemoryTracer();
    await runAgent(scripted([call("add_application", { ...init, confirm: true }), { text: "Could not." }]), client, "add", { tracer: t });
    const blocked = t.events.find((e) => e.type === "tool_call" && e.blocked);
    expect(blocked).toBeDefined();
    expect(t.events.find((e) => e.type === "guard")).toMatchObject({ kind: "write_blocked", detail: expect.stringContaining("add_application") });

    const t2 = new MemoryTracer();
    await runAgent(
      scripted([call("search_profile", { query: "PostgreSQL query latency" }), { text: "Cut 38%." }, { text: "Cut 38% [resume.md#0]." }]),
      client, "q", { tracer: t2 },
    );
    expect(t2.events.filter((e) => e.type === "guard")).toMatchObject([{ kind: "citation_retry" }]);
  });

  it("closes the trace when the model call throws, then rethrows", async () => {
    const { client } = await connectedPair();
    const t = new MemoryTracer();
    const boom: LLMClient = { provider: "fake", model: "m", chat: async () => { throw new Error("quota"); } };
    await expect(runAgent(boom, client, "q", { tracer: t })).rejects.toThrow("quota");
    expect(t.events.map((e) => e.type)).toEqual(["run_start", "run_end"]);
    expect(t.events.at(-1)).toMatchObject({ stoppedBecause: "error" });
  });

  it("works without a tracer", async () => {
    const { client } = await connectedPair();
    expect((await runAgent(scripted([{ text: "hi" }]), client, "q")).answer).toBe("hi");
  });
});

describe("tracers and helpers", () => {
  it("JsonlTracer writes one parseable line per event and clips long fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ja-trace-"));
    const file = join(dir, "nested", "t.jsonl");
    const tr = new JsonlTracer(file);
    const ev: TraceEvent = { type: "run_start", runId: "r", ts: "2026-10-18T00:00:00.000Z", provider: "p", model: "m", user: clip("x".repeat(1000), 50) };
    tr.emit(ev);
    tr.emit({ ...ev, runId: "r2" });
    const events = parseTrace(await readFile(file, "utf8"));
    expect(events.map((e) => e.runId)).toEqual(["r", "r2"]);
    expect((events[0] as any).user).toMatch(/… \(1000 chars\)$/);
  });

  it("multiTracer fans out and ignores undefined", () => {
    const a = new MemoryTracer(), b = new MemoryTracer();
    multiTracer(a, undefined, b).emit({ type: "guard", runId: "r", ts: "t", step: 1, kind: "citation_retry", detail: "d" });
    expect([a.events.length, b.events.length]).toEqual([1, 1]);
  });

  it("percentile uses nearest rank", () => {
    expect(percentile([], 50)).toBeUndefined();
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
    expect(percentile([5], 95)).toBe(5);
  });
});

describe("TimedLLM and the cache", () => {
  const req: ChatRequest = { system: "s", tools: [], messages: [{ role: "user", text: "q" }] };

  it("stamps latency and keeps provider/model", async () => {
    const inner: LLMClient = { provider: "p", model: "m", chat: async () => { await new Promise((r) => setTimeout(r, 15)); return { text: "", toolCalls: [], finish: "stop", usage: { inputTokens: 0, outputTokens: 0 } }; } };
    const timed = new TimedLLM(inner);
    expect(timed).toMatchObject({ provider: "p", model: "m" });
    expect((await timed.chat(req)).latencyMs).toBeGreaterThanOrEqual(10);
  });

  it("a cache hit replays the original call's latency, not ~0ms", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ja-lat-"));
    const inner: LLMClient = { provider: "p", model: "m", chat: async () => ({ text: "x", toolCalls: [], finish: "stop", usage: { inputTokens: 0, outputTokens: 0 }, latencyMs: 777 }) };
    const llm = new CachingLLM(inner, dir);
    await llm.chat(req);
    const hit = await llm.chat(req);
    expect(llm.hits).toBe(1);
    expect(hit.latencyMs).toBe(777);
  });
});

describe("retry visibility", () => {
  it("withRetry reports each retry with its wait", async () => {
    const seen: Array<{ attempt: number; waitMs: number }> = [];
    let n = 0;
    await withRetry(async () => { if (++n < 3) throw Object.assign(new Error("x"), { status: 503 }); }, {
      sleep: async () => {}, baseDelayMs: 100, onRetry: ({ attempt, waitMs }) => seen.push({ attempt, waitMs }),
    });
    expect(seen.map((s) => s.attempt)).toEqual([1, 2]);
    expect(seen.every((s) => s.waitMs > 0)).toBe(true);
  });

  it("the Anthropic adapter surfaces its retry count, and the trace shows it", async () => {
    const ok: WireResponse = { content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
    let i = 0;
    const create = async () => { if (i++ < 2) throw Object.assign(new Error("overloaded"), { status: 529 }); return ok; };
    const api: AnthropicLike = { messages: { create }, beta: { messages: { create } } };
    // zero-delay retries: a stub clock isn't injectable here, so keep the real backoff short by retrying twice only
    const res = await new AnthropicClient("m", { client: api }).chat({ system: "s", tools: [], messages: [{ role: "user", text: "q" }] });
    expect(res.retries).toBe(2);

    const { client } = await connectedPair();
    const t = new MemoryTracer();
    await runAgent(scripted([{ text: "ok", retries: 2, latencyMs: 4000 }]), client, "q", { tracer: t });
    const llm = t.events.find((e) => e.type === "llm_call") as Extract<TraceEvent, { type: "llm_call" }>;
    expect(llm.retries).toBe(2);
    expect(formatTrace(t.events)).toContain("[2 retries]");
    expect(summarizeEvents(t.events).llm).toMatchObject({ retried: 1, retries: 2 });
  }, 20_000);
});

describe("trace viewer and statistics", () => {
  const events: TraceEvent[] = [
    { type: "run_start", runId: "r", ts: "2026-10-18T10:00:00.000Z", provider: "gemini", model: "m", user: "hello" },
    { type: "llm_call", runId: "r", ts: "2026-10-18T10:00:01.000Z", step: 1, ms: 900, inputTokens: 100, outputTokens: 5, finish: "tool_calls", toolCalls: ["add_application"] },
    { type: "guard", runId: "r", ts: "2026-10-18T10:00:01.100Z", step: 1, kind: "write_blocked", detail: "add_application: no preview" },
    { type: "tool_call", runId: "r", ts: "2026-10-18T10:00:01.100Z", step: 1, name: "add_application", args: "{}", ms: 3, isError: true, blocked: true, result: "Blocked" },
    { type: "llm_call", runId: "r", ts: "2026-10-18T10:00:02.500Z", step: 2, ms: 1500, inputTokens: 120, outputTokens: 20, finish: "stop", toolCalls: [] },
    { type: "tool_call", runId: "r", ts: "2026-10-18T10:00:02.600Z", step: 2, name: "list_followups", args: "{}", ms: 7, isError: false, result: "[]" },
    { type: "run_end", runId: "r", ts: "2026-10-18T10:00:02.600Z", ms: 2600, steps: 2, stoppedBecause: "answered", inputTokens: 220, outputTokens: 25, answerChars: 10 },
  ];

  it("formatTrace prints a timeline with times, tokens, and guard/blocked markers", () => {
    const text = formatTrace(events);
    expect(text).toContain("RUN    gemini/m");
    expect(text).toContain("+1.00s  MODEL  step 1  900ms  100 in / 5 out  -> tool_calls (add_application)");
    expect(text).toMatch(/GUARD\s+step 1\s+write_blocked/);
    expect(text).toMatch(/TOOL\s+step 1\s+3ms\s+add_application\(\{\}\)\s+BLOCKED/);
    expect(text).toMatch(/END\s+answered\s+2 model call\(s\)\s+2\.6s total/);
  });

  it("summarizeEvents computes latency percentiles, per-tool stats and guard counts", () => {
    const s = summarizeEvents(events);
    expect(s).toMatchObject({ runs: 1, llm: { calls: 2, timed: 2, p50: 900, p95: 1500, max: 1500, inputTokens: 220, outputTokens: 25 }, guards: { writeBlocked: 1, citationRetry: 0 } });
    expect(s.tools.find((t) => t.name === "add_application")).toMatchObject({ calls: 1, errors: 1, blocked: 1 });
    const text = formatStats(s).join("\n");
    expect(text).toContain("| model call (API time) | 900ms | 1.5s | 1.5s |");
    expect(text).toContain("| add_application | 1 | 1 | 1 |");
  });

  it("calls without a recorded latency are counted but not timed", () => {
    const s = summarizeEvents([{ ...(events[1] as any), ms: undefined }]);
    expect(s.llm).toMatchObject({ calls: 1, timed: 0, p50: undefined });
    expect(formatStats(s).join("\n")).toContain("n/a");
  });
});

describe("eval integration", () => {
  it("attaches trace events to case results, writes per-case files and prints a performance section", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ja-evtrace-"));
    const c = (await loadCases()).find((k) => k.id === "followups_week")!;
    const r = await runCase(c, { llm: scripted([call("list_followups", { days: 7 }), { text: "Contoso and Northwind are due." }]), traceDir: dir });
    expect(r.events?.map((e) => e.type)).toEqual(["run_start", "llm_call", "tool_call", "llm_call", "run_end"]);
    expect(r.events?.[0]?.runId).toBe("followups_week-t0");
    expect(await readdir(dir)).toEqual(["followups_week.jsonl"]);
    expect(parseTrace(await readFile(join(dir, "followups_week.jsonl"), "utf8"))).toHaveLength(5);
    const report = formatReport({ provider: "fake", model: "fake-1", date: "d" }, [r]);
    expect(report).toContain("## Performance");
    expect(report).toContain("list_followups");
  });
});
