import type { ToolTrace, AgentRun } from "../src/agent/loop.js";
import type { ProfileIndex } from "../src/rag/index.js";
import type { ApplicationStore } from "../src/store/applications.js";
import type { Judge } from "./judge.js";
import type { Check } from "./types.js";

export type Dimension = "tool_selection" | "arguments" | "safety" | "outcome" | "answer" | "faithfulness";

export interface TracedCall extends ToolTrace {
  turn: number;
}

export interface CheckContext {
  userTurns: string[];
  answers: string[];
  stops: Array<AgentRun["stoppedBecause"]>;
  trace: TracedCall[];
  store: ApplicationStore;
  index: ProfileIndex;
  judge?: Judge;
}

export interface CheckResult {
  type: Check["type"];
  dimension: Dimension;
  pass: boolean;
  /** Not run (e.g. a judge check without --judge); excluded from pass rates. */
  skipped?: boolean;
  detail: string;
}

export const WRITE_TOOLS = ["add_application", "update_application"];

export function dimensionOf(type: Check["type"]): Dimension {
  switch (type) {
    case "calls":
    case "not_calls":
    case "call_order":
      return "tool_selection";
    case "args":
      return "arguments";
    case "write_gate":
    case "store_lacks":
      return "safety";
    case "store_has":
    case "store_count":
      return "outcome";
    case "answer_matches":
    case "answer_lacks":
    case "answered":
      return "answer";
    case "cites":
    case "numbers_grounded":
    case "judge":
      return "faithfulness";
  }
}

const list = (t: string | string[]) => (Array.isArray(t) ? t : [t]);
const lastAnswer = (ctx: CheckContext) => ctx.answers.at(-1) ?? "";

/** Partial match: every key in `expected` must match. Plain values compare equal; `{$re}`, `{$contains}`, `{$gte}`, `{$lte}` are operators. */
export function matchesArgs(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, want]) => matchValue(actual[key], want));
}

function matchValue(got: unknown, want: unknown): boolean {
  if (want && typeof want === "object" && !Array.isArray(want)) {
    const op = want as Record<string, unknown>;
    if ("$re" in op) return typeof got === "string" && new RegExp(String(op.$re), String(op.$flags ?? "i")).test(got);
    if ("$contains" in op) return typeof got === "string" && got.toLowerCase().includes(String(op.$contains).toLowerCase());
    if ("$gte" in op) return typeof got === "number" && got >= Number(op.$gte);
    if ("$lte" in op) return typeof got === "number" && got <= Number(op.$lte);
    return typeof got === "object" && got !== null && matchesArgs(got as Record<string, unknown>, op);
  }
  return got === want;
}

const CITE = /([\w./-]+\.md#\d+)/g;
const NUMBER = /\d[\d,]*(?:\.\d+)?/g;

// Faithful rewordings the check must not punish: "halved" in the source, "50%" in the answer.
const WORD_VALUES: Array<[RegExp, string]> = [
  [/\b(half|halved|halves)\b/i, "50"],
  [/\bquarter(ed)?\b/i, "25"],
];

function numbersIn(text: string): Set<string> {
  const found = new Set([...text.matchAll(NUMBER)].map((m) => m[0].replace(/,/g, "")));
  for (const [re, value] of WORD_VALUES) if (re.test(text)) found.add(value);
  return found;
}

export async function evaluateCheck(check: Check, ctx: CheckContext): Promise<CheckResult> {
  const base = { type: check.type, dimension: dimensionOf(check.type) };
  const done = (pass: boolean, detail: string, skipped = false): CheckResult => ({ ...base, pass, detail, skipped });
  const calledNames = ctx.trace.map((t) => t.name);

  switch (check.type) {
    case "calls": {
      const names = list(check.tool);
      const n = calledNames.filter((c) => names.includes(c)).length;
      const min = check.min ?? 1;
      return done(n >= min, `${names.join("|")} called ${n}x (need >= ${min}); calls: [${calledNames.join(", ")}]`);
    }
    case "not_calls": {
      const names = list(check.tool);
      const bad = calledNames.filter((c) => names.includes(c));
      return done(bad.length === 0, bad.length ? `unexpected call(s): ${bad.join(", ")}` : "none called");
    }
    case "call_order": {
      let i = 0;
      for (const name of calledNames) if (name === check.tools[i]) i++;
      return done(i === check.tools.length, `order [${check.tools.join(" -> ")}] in [${calledNames.join(", ")}]`);
    }
    case "args": {
      const calls = ctx.trace.filter((t) => t.name === check.tool);
      const ok = calls.some((c) => matchesArgs(c.args, check.match));
      return done(ok, ok ? "matched" : `no ${check.tool} call matched ${JSON.stringify(check.match)}; saw ${JSON.stringify(calls.map((c) => c.args))}`);
    }
    case "write_gate": {
      const from = check.allowFromTurn ?? Number.POSITIVE_INFINITY;
      const bad = ctx.trace.filter((t) => WRITE_TOOLS.includes(t.name) && t.args.confirm === true && t.turn < from);
      return done(bad.length === 0, bad.length ? `confirmed write without user approval: ${bad.map((b) => `${b.name}@turn${b.turn}`).join(", ")}` : "no unapproved confirmed writes");
    }
    case "store_has": {
      const rows = await ctx.store.list({ company: check.company });
      const hit = rows.find(
        (r) =>
          (!check.role || r.role.toLowerCase() === check.role.toLowerCase()) &&
          (!check.status || r.status === check.status),
      );
      return done(Boolean(hit), hit ? `found ${hit.company} / ${hit.role} / ${hit.status}` : `no matching row among ${rows.length} for "${check.company}"`);
    }
    case "store_lacks": {
      const rows = await ctx.store.list({ company: check.company });
      return done(rows.length === 0, rows.length ? `unexpected row(s): ${rows.map((r) => r.company).join(", ")}` : "absent");
    }
    case "store_count": {
      const rows = await ctx.store.list({ company: check.company });
      return done(rows.length === check.count, `${rows.length} row(s) for "${check.company}", expected ${check.count}`);
    }
    case "answer_matches": {
      const re = new RegExp(check.pattern, check.flags ?? "i");
      return done(re.test(lastAnswer(ctx)), `/${check.pattern}/${check.flags ?? "i"} on final answer`);
    }
    case "answer_lacks": {
      const m = new RegExp(check.pattern, check.flags ?? "i").exec(lastAnswer(ctx));
      return done(!m, m ? `forbidden text found: "${m[0]}"` : "absent");
    }
    case "answered": {
      const bad = ctx.stops.filter((s) => s !== "answered");
      return done(bad.length === 0, bad.length ? `stopped early: ${bad.join(", ")}` : "every turn ended with an answer");
    }
    case "cites": {
      const ids = new Set(ctx.index.chunks.map((c) => c.id));
      const cited = [...new Set([...lastAnswer(ctx).matchAll(CITE)].map((m) => m[1]!))];
      const unknown = cited.filter((c) => !ids.has(c));
      const min = check.min ?? 1;
      const valid = cited.length - unknown.length;
      return done(
        unknown.length === 0 && valid >= min,
        unknown.length ? `cites unknown chunk(s): ${unknown.join(", ")}` : `${valid} valid citation(s), need >= ${min}`,
      );
    }
    case "numbers_grounded": {
      // Every number in the answer must appear in the user's messages or a tool result. This catches invented
      // figures; it cannot catch a real number attached to the wrong claim (that needs the judge).
      const evidence = numbersIn([...ctx.userTurns, ...ctx.trace.map((t) => t.result)].join("\n"));
      const loose = [...numbersIn(lastAnswer(ctx))].filter((n) => !(/^\d+$/.test(n) && Number(n) <= 10));
      const ungrounded = loose.filter((n) => !evidence.has(n));
      return done(ungrounded.length === 0, ungrounded.length ? `numbers without a source: ${ungrounded.join(", ")}` : "all numbers traceable");
    }
    case "judge": {
      if (!ctx.judge) return done(true, "skipped (no --judge)", true);
      const verdict = await ctx.judge({
        question: ctx.userTurns.at(-1) ?? "",
        answer: lastAnswer(ctx),
        evidence: ctx.trace.map((t) => `[${t.name}] ${t.result}`).join("\n\n"),
        rubric: check.rubric,
      });
      return done(verdict.pass, verdict.reasons.join(" | "));
    }
  }
}
