import { runAgent } from "../src/agent/loop.js";
import type { AgentRun } from "../src/agent/loop.js";
import type { LLMClient, Message, Usage } from "../src/agent/llm/types.js";
import { evaluateCheck, type CheckResult, type TracedCall } from "./checks.js";
import { createEnv, type EvalEnv } from "./env.js";
import type { Judge } from "./judge.js";
import type { EvalCase } from "./types.js";

export interface CaseResult {
  id: string;
  category: EvalCase["category"];
  passed: boolean;
  checks: CheckResult[];
  tools: string[];
  answer: string;
  steps: number;
  usage: Usage;
  ms: number;
  /** Set when the run itself failed (API error etc.), as opposed to a check failing. */
  error?: string;
}

export interface RunOptions {
  llm: LLMClient;
  judge?: Judge;
  maxSteps?: number;
  concurrency?: number;
  makeEnv?: () => Promise<EvalEnv>;
  onResult?: (r: CaseResult, done: number, total: number) => void;
}

export async function runCase(c: EvalCase, opts: RunOptions): Promise<CaseResult> {
  const started = Date.now();
  const env = await (opts.makeEnv ?? createEnv)();
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const trace: TracedCall[] = [];
  const answers: string[] = [];
  const stops: Array<AgentRun["stoppedBecause"]> = [];
  let history: Message[] = [];
  let steps = 0;
  try {
    for (const [turn, text] of c.turns.entries()) {
      const run = await runAgent(opts.llm, env.client, text, { history, maxSteps: opts.maxSteps });
      history = run.messages;
      trace.push(...run.trace.map((t) => ({ ...t, turn })));
      answers.push(run.answer);
      stops.push(run.stoppedBecause);
      steps += run.steps;
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
          detail: `grader error: ${err instanceof Error ? err.message : err}`,
        });
      }
    }
    return {
      id: c.id,
      category: c.category,
      passed: checks.filter((k) => !k.skipped).every((k) => k.pass),
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
