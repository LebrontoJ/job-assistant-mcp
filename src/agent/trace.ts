import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * One line per thing that happened in an agent run. The shapes are flat and JSON-friendly on purpose: a trace file
 * can be read with `jq`, loaded into a notebook, or printed with `pnpm trace <file>`.
 */
export type TraceEvent =
  | { type: "run_start"; runId: string; ts: string; provider: string; model: string; user: string }
  | {
      type: "llm_call";
      runId: string;
      ts: string;
      step: number;
      /** Time spent in the model API call itself (retries included, rate-limit waits excluded). Unknown for old recordings. */
      ms?: number;
      /** Retries (429/5xx) the adapter made inside this call; their backoff is part of `ms`. */
      retries?: number;
      inputTokens: number;
      outputTokens: number;
      finish: string;
      toolCalls: string[];
    }
  | {
      type: "tool_call";
      runId: string;
      ts: string;
      step: number;
      name: string;
      args: string;
      ms: number;
      isError: boolean;
      blocked?: boolean;
      result: string;
    }
  | { type: "guard"; runId: string; ts: string; step: number; kind: "write_blocked" | "citation_retry"; detail: string }
  | {
      type: "run_end";
      runId: string;
      ts: string;
      ms: number;
      steps: number;
      stoppedBecause: string;
      inputTokens: number;
      outputTokens: number;
      answerChars: number;
    };

export interface Tracer {
  emit(event: TraceEvent): void;
}

/** Keeps traces small and avoids copying whole profile documents into files. */
export const clip = (text: string, n = 400): string => (text.length > n ? `${text.slice(0, n)}… (${text.length} chars)` : text);

export class MemoryTracer implements Tracer {
  readonly events: TraceEvent[] = [];
  emit(event: TraceEvent): void {
    this.events.push(event);
  }
}

export class JsonlTracer implements Tracer {
  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
  }
  emit(event: TraceEvent): void {
    // Synchronous append keeps events in order even when tool calls finish concurrently.
    appendFileSync(this.file, JSON.stringify(event) + "\n", "utf8");
  }
}

export function multiTracer(...tracers: Array<Tracer | undefined>): Tracer {
  const live = tracers.filter((t): t is Tracer => t !== undefined);
  return { emit: (e) => live.forEach((t) => t.emit(e)) };
}

export const parseTrace = (jsonl: string): TraceEvent[] =>
  jsonl
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as TraceEvent);

/** Nearest-rank percentile; undefined for no data. */
export function percentile(values: number[], p: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

const ms = (v: number | undefined) => (v === undefined ? "n/a" : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`);

/** A readable timeline of one run. */
export function formatTrace(events: TraceEvent[]): string {
  const out: string[] = [];
  const t0 = events[0] ? Date.parse(events[0].ts) : 0;
  const at = (e: TraceEvent) => `+${((Date.parse(e.ts) - t0) / 1000).toFixed(2)}s`.padStart(9);
  for (const e of events) {
    switch (e.type) {
      case "run_start":
        out.push(`${at(e)}  RUN    ${e.provider}/${e.model}  "${clip(e.user, 80)}"  [${e.runId}]`);
        break;
      case "llm_call":
        out.push(
          `${at(e)}  MODEL  step ${e.step}  ${ms(e.ms)}  ${e.inputTokens} in / ${e.outputTokens} out  -> ${e.finish}${e.toolCalls.length ? ` (${e.toolCalls.join(", ")})` : ""}${e.retries ? `  [${e.retries} retr${e.retries === 1 ? "y" : "ies"}]` : ""}`,
        );
        break;
      case "tool_call":
        out.push(
          `${at(e)}  TOOL   step ${e.step}  ${ms(e.ms)}  ${e.name}(${clip(e.args, 80)})${e.blocked ? "  BLOCKED" : e.isError ? "  ERROR" : ""}`,
        );
        break;
      case "guard":
        out.push(`${at(e)}  GUARD  step ${e.step}  ${e.kind}: ${clip(e.detail, 100)}`);
        break;
      case "run_end":
        out.push(`${at(e)}  END    ${e.stoppedBecause}  ${e.steps} model call(s)  ${ms(e.ms)} total  ${e.inputTokens} in / ${e.outputTokens} out`);
        break;
    }
  }
  return out.join("\n");
}

export interface TraceStats {
  runs: number;
  llm: { calls: number; timed: number; retried: number; retries: number; p50?: number; p95?: number; max?: number; inputTokens: number; outputTokens: number };
  tools: Array<{ name: string; calls: number; errors: number; blocked: number; avgMs: number; maxMs: number }>;
  runMs: { p50?: number; p95?: number };
  guards: { writeBlocked: number; citationRetry: number };
}

/** Aggregates any number of runs' events (e.g. a whole eval) into the numbers a report needs. */
export function summarizeEvents(events: TraceEvent[]): TraceStats {
  const llmMs = events.flatMap((e) => (e.type === "llm_call" && e.ms !== undefined ? [e.ms] : []));
  const llmCalls = events.filter((e): e is Extract<TraceEvent, { type: "llm_call" }> => e.type === "llm_call");
  const byTool = new Map<string, { calls: number; errors: number; blocked: number; total: number; max: number }>();
  for (const e of events) {
    if (e.type !== "tool_call") continue;
    const t = byTool.get(e.name) ?? { calls: 0, errors: 0, blocked: 0, total: 0, max: 0 };
    t.calls++;
    if (e.isError) t.errors++;
    if (e.blocked) t.blocked++;
    t.total += e.ms;
    t.max = Math.max(t.max, e.ms);
    byTool.set(e.name, t);
  }
  const ends = events.filter((e): e is Extract<TraceEvent, { type: "run_end" }> => e.type === "run_end");
  return {
    runs: ends.length,
    llm: {
      calls: llmCalls.length,
      timed: llmMs.length,
      retried: llmCalls.filter((e) => e.retries).length,
      retries: llmCalls.reduce((a, e) => a + (e.retries ?? 0), 0),
      p50: percentile(llmMs, 50),
      p95: percentile(llmMs, 95),
      max: llmMs.length ? Math.max(...llmMs) : undefined,
      inputTokens: llmCalls.reduce((a, e) => a + e.inputTokens, 0),
      outputTokens: llmCalls.reduce((a, e) => a + e.outputTokens, 0),
    },
    tools: [...byTool.entries()]
      .map(([name, t]) => ({ name, calls: t.calls, errors: t.errors, blocked: t.blocked, avgMs: t.total / t.calls, maxMs: t.max }))
      .sort((a, b) => b.calls - a.calls),
    runMs: { p50: percentile(ends.map((e) => e.ms), 50), p95: percentile(ends.map((e) => e.ms), 95) },
    guards: {
      writeBlocked: events.filter((e) => e.type === "guard" && e.kind === "write_blocked").length,
      citationRetry: events.filter((e) => e.type === "guard" && e.kind === "citation_retry").length,
    },
  };
}

export function formatStats(s: TraceStats): string[] {
  const out = [
    "## Performance",
    "",
    `${s.runs} agent run(s), ${s.llm.calls} model call(s) (${s.llm.timed} with a recorded API latency); ${s.llm.retried} call(s) needed retries (${s.llm.retries} retries in total, waits included in the latencies)`,
    "",
    "| | p50 | p95 | max |",
    "|---|---|---|---|",
    `| model call (API time) | ${ms(s.llm.p50)} | ${ms(s.llm.p95)} | ${ms(s.llm.max)} |`,
    `| agent run (wall time) | ${ms(s.runMs.p50)} | ${ms(s.runMs.p95)} | |`,
    "",
  ];
  if (s.tools.length) {
    out.push("| tool | calls | errors | blocked | avg | max |", "|---|---|---|---|---|---|");
    for (const t of s.tools) out.push(`| ${t.name} | ${t.calls} | ${t.errors} | ${t.blocked} | ${ms(t.avgMs)} | ${ms(t.maxMs)} |`);
    out.push("");
  }
  out.push(`Tokens per model call: ${s.llm.calls ? Math.round(s.llm.inputTokens / s.llm.calls) : 0} in / ${s.llm.calls ? Math.round(s.llm.outputTokens / s.llm.calls) : 0} out`, "");
  return out;
}
