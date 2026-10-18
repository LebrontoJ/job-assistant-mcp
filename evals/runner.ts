import { runAgent } from "../src/agent/loop.js";
import { JsonlTracer, MemoryTracer, multiTracer, type TraceEvent } from "../src/agent/trace.js";
import { join } from "node:path";
import type { AgentRun } from "../src/agent/loop.js";
import type { LLMClient, Message, Usage } from "../src/agent/llm/types.js";
import { evaluateCheck, type CheckResult, type TracedCall } from "./checks.js";
import { createEnv, type EvalEnv } from "./env.js";
import type { Judge } from "./judge.js";
import type { EvalCase } from "./types.js";

export interface CaseResult {
  id: string;
  category: EvalCase["category"];
  suite: EvalCase["suite"];
  passed: boolean;
  checks: CheckResult[];
  tools: string[];
  answer: string;
  steps: number;
  usage: Usage;
  ms: number;
  /** Confirmed writes the host refused (the model tried to skip preview/approval). */
  blocked: number;
  /** Times the citation guard sent the model back to fix its sources. */
  citationRetries: number;
  /** No real check failed, but a grader error left at least one check unevaluated. Neither pass nor fail. */
  ungraded?: boolean;
  /** Trace events of every turn, for latency and tool statistics. */
  events?: TraceEvent[];
  /** Set when the run itself failed (API error etc.), as opposed to a check failing. */
  error?: string;
}

export interface RunOptions {
  llm: LLMClient;
  judge?: Judge;
  maxSteps?: number;
  concurrency?: number;
  makeEnv?: (c: EvalCase) => Promise<EvalEnv>;
  /** If set, each case's trace is also written to <traceDir>/<caseId>.jsonl. */
  traceDir?: string;
  onResult?: (r: CaseResult, done: number, total: number) => void;
}

export async function runCase(c: EvalCase, opts: RunOptions): Promise<CaseResult> {
  const started = Date.now();
  const env = await (opts.makeEnv ??
    ((k: EvalCase) => createEnv({ applications: k.fixture?.applications, profileDir: k.fixture?.profile })))(c);
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const trace: TracedCall[] = [];
  const memory = new MemoryTracer();
  const tracer = multiTracer(memory, opts.traceDir ? new JsonlTracer(join(opts.traceDir, `${c.id}.jsonl`)) : undefined);
  const answers: string[] = [];
  const stops: Array<AgentRun["stoppedBecause"]> = [];
  let history: Message[] = [];
  let steps = 0;
  let blocked = 0;
  let citationRetries = 0;
  try {
    for (const [turn, text] of c.turns.entries()) {
      const run = await runAgent(opts.llm, env.client, text, { history, maxSteps: opts.maxSteps, tracer, runId: `${c.id}-t${turn}` });
      history = run.messages;
      trace.push(...run.trace.map((t) => ({ ...t, turn })));
      answers.push(run.answer);
      stops.push(run.stoppedBecause);
      steps += run.steps;
      blocked += run.blockedWrites;
      citationRetries += run.citationRetries;
      usage.inputTokens += run.usage.inputTokens;
      usage.outputTokens += run.usage.outputTokens;
    }
    const ctx = { userTurns: c.turns, answers, stops, trace, store: env.store, index: env.index, judge: opts.judge };
    const checks: CheckResult[] = [];
    for (const check of c.checks) {
      try {
        checks.push(await evaluateCheck(check, ctx));
      } catch (err) {
        // A broken grader (e.g. judge model error) must not read as the model passing.
        checks.push({
          type: check.type,
          dimension: "faithfulness",
          pass: false,
          graderError: true,
          detail: `grader error: ${err instanceof Error ? err.message : err}`,
        });
      }
    }
    return {
      id: c.id,
      category: c.category,
      suite: c.suite,
      blocked,
      citationRetries,
      events: memory.events,
      passed: checks.filter((k) => !k.skipped).every((k) => k.pass),
      ungraded: checks.some((k) => k.graderError) && checks.every((k) => k.pass || k.skipped || k.graderError),
      checks,
      tools: trace.map((t) => t.name),
      answer: answers.at(-1) ?? "",
      steps,
      usage,
      ms: Date.now() - started,
    };
  } catch (err) {
    return {
      id: c.id,
      category: c.category,
      suite: c.suite,
      blocked,
      citationRetries,
      events: memory.events,
      passed: false,
      checks: [],
      tools: trace.map((t) => t.name),
      answer: answers.at(-1) ?? "",
      steps,
      usage,
      ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await env.close();
  }
}

/** Runs cases with bounded concurrency (free API tiers rate-limit hard); results keep input order. */
export async function runEval(cases: EvalCase[], opts: RunOptions): Promise<CaseResult[]> {
  const results: CaseResult[] = new Array(cases.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= cases.length) return;
      results[i] = await runCase(cases[i]!, opts);
      opts.onResult?.(results[i]!, ++done, cases.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 2, cases.length)) }, worker));
  return results;
}
