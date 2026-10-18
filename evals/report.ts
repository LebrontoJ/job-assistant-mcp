import type { CaseResult } from "./runner.js";
import type { RankChange, RetrievalSummary } from "./retrieval.js";

export interface Tally {
  passed: number;
  total: number;
  skipped: number;
}
export interface Summary {
  cases: Tally;
  errors: number;
  byCategory: Record<string, Tally>;
  byDimension: Record<string, Tally>;
  usage: { inputTokens: number; outputTokens: number };
  avgSteps: number;
}

const tally = (): Tally => ({ passed: 0, total: 0, skipped: 0 });

export function summarize(results: CaseResult[]): Summary {
  const s: Summary = {
    cases: tally(),
    errors: 0,
    byCategory: {},
    byDimension: {},
    usage: { inputTokens: 0, outputTokens: 0 },
    avgSteps: 0,
  };
  for (const r of results) {
    s.cases.total++;
    if (r.passed) s.cases.passed++;
    if (r.error) s.errors++;
    const cat = (s.byCategory[r.category] ??= tally());
    cat.total++;
    if (r.passed) cat.passed++;
    for (const k of r.checks) {
      const dim = (s.byDimension[k.dimension] ??= tally());
      if (k.skipped) dim.skipped++;
      else {
        dim.total++;
        if (k.pass) dim.passed++;
      }
    }
    s.usage.inputTokens += r.usage.inputTokens;
    s.usage.outputTokens += r.usage.outputTokens;
    s.avgSteps += r.steps;
  }
  s.avgSteps = results.length ? s.avgSteps / results.length : 0;
  return s;
}

const pct = (t: Tally) => (t.total ? `${((100 * t.passed) / t.total).toFixed(0)}%` : "n/a");
const row = (name: string, t: Tally) =>
  `| ${name} | ${t.passed}/${t.total} | ${pct(t)}${t.skipped ? ` (+${t.skipped} skipped)` : ""} |`;

export interface Meta {
  provider: string;
  model: string;
  judge?: string;
  cache?: { hits: number; misses: number };
  date: string;
}

export interface RetrievalReport {
  /** Per search mode, e.g. bm25 / dense / hybrid. */
  modes: Record<string, RetrievalSummary>;
  /** Rank changes of each non-baseline mode against bm25. */
  changes?: Record<string, { improved: RankChange[]; regressed: RankChange[] }>;
  embedder?: string;
}

const rank = (r: number | null) => (r === null ? "miss" : `#${r}`);

export function formatRetrieval(r: RetrievalReport): string[] {
  const first = Object.values(r.modes)[0];
  const out = ["## Retrieval", "", `${first?.cases ?? 0} queries${r.embedder ? ` · embedder: ${r.embedder}` : ""}`, ""];
  out.push("| mode | recall@1 | recall@3 | recall@5 | MRR |", "|---|---|---|---|---|");
  for (const [mode, s] of Object.entries(r.modes)) {
    out.push(`| ${mode} | ${[1, 3, 5].map((k) => s.recallAt[k]!.toFixed(2)).join(" | ")} | ${s.mrr.toFixed(2)} |`);
  }
  for (const [mode, c] of Object.entries(r.changes ?? {})) {
    const line = (x: RankChange) => `  - ${x.id}: ${rank(x.from)} -> ${rank(x.to)} ("${x.query}")`;
    if (c.improved.length) out.push("", `${mode} improved vs bm25:`, ...c.improved.map(line));
    if (c.regressed.length) out.push("", `${mode} regressed vs bm25:`, ...c.regressed.map(line));
  }
  for (const [mode, s] of Object.entries(r.modes)) {
    if (s.misses.length) out.push("", `${mode}: no relevant chunk in top 5 for ${s.misses.join(", ")}`);
  }
  out.push("");
  return out;
}

export function formatReport(meta: Meta, results: CaseResult[], retrieval?: RetrievalReport): string {
  const s = summarize(results);
  const out: string[] = [];
  out.push(`# Eval report: ${meta.provider}/${meta.model}`, "");
  out.push(`${meta.date}${meta.judge ? ` · judge: ${meta.judge}` : " · no judge (faithfulness judged by rules only)"}`);
  if (meta.cache) out.push(`LLM cache: ${meta.cache.hits} hits, ${meta.cache.misses} live calls`);
  out.push("");
  if (results.length) {
    out.push(`**Cases passed: ${s.cases.passed}/${s.cases.total} (${pct(s.cases)})**${s.errors ? ` · ${s.errors} run error(s)` : ""}`, "");
    out.push("| Dimension | Checks passed | Rate |", "|---|---|---|");
    for (const [k, t] of Object.entries(s.byDimension).sort()) out.push(row(k, t));
    out.push("", "| Category | Cases passed | Rate |", "|---|---|---|");
    for (const [k, t] of Object.entries(s.byCategory).sort()) out.push(row(k, t));
    out.push("", `Tokens: ${s.usage.inputTokens} in / ${s.usage.outputTokens} out · avg model calls per case: ${s.avgSteps.toFixed(1)}`, "");
    const failed = results.filter((r) => !r.passed);
    if (failed.length) {
      out.push("## Failures", "");
      for (const r of failed) {
        out.push(`- **${r.id}** (${r.category})${r.error ? ` — run error: ${r.error}` : ""}`);
        for (const k of r.checks.filter((c) => !c.pass && !c.skipped)) out.push(`  - ${k.type}: ${k.detail}`);
      }
      out.push("");
    }
  }
  if (retrieval) out.push(...formatRetrieval(retrieval));
  return out.join("\n");
}
