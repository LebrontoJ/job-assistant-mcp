import type { ProfileIndex } from "../src/rag/index.js";
import { bestByCoverage, decideSupport, isQuantitative, type SemanticThresholds, type Support } from "../src/server/match.js";
import type { MatchCase } from "./types.js";

export interface Signals {
  case: MatchCase;
  coverage: number;
  matched: number;
  terms: number;
  similarity?: number;
  quantitative: boolean;
}

/** Retrieves once per requirement, so thresholds can be swept without calling the embedding API again. */
export async function collectSignals(cases: MatchCase[], index: ProfileIndex): Promise<Signals[]> {
  const out: Signals[] = [];
  for (const c of cases) {
    const hits = await index.search(c.item, 3);
    const sims = hits.flatMap((h) => (h.similarity === undefined ? [] : [h.similarity]));
    const best = bestByCoverage(hits);
    out.push({
      case: c,
      coverage: best?.coverage ?? 0,
      matched: best?.matched ?? 0,
      terms: best?.terms ?? 0,
      similarity: sims.length ? Math.max(...sims) : undefined,
      quantitative: isQuantitative(c.item),
    });
  }
  return out;
}

export interface Scored {
  id: string;
  split: MatchCase["split"];
  truth: Support;
  predicted: Support;
  coverage: number;
  similarity?: number;
}

export function score(signals: Signals[], semantic?: SemanticThresholds): Scored[] {
  return signals.map((s) => ({
    id: s.case.id,
    split: s.case.split,
    truth: s.case.truth,
    predicted: decideSupport({ coverage: s.coverage, matched: s.matched, terms: s.terms, similarity: s.similarity, quantitative: s.quantitative }, semantic).support,
    coverage: s.coverage,
    similarity: s.similarity,
  }));
}

export interface MatchSummary {
  n: number;
  accuracy: number;
  /** Said `supported` where the truth is not `supported`. The error that matters most. */
  falseSupported: number;
  /** Showed evidence for something the profile does not contain. */
  overreach: number;
  /** Of the truly supported requirements, how many got any evidence shown. */
  surfaced: { found: number; total: number };
  /** Of the truly supported, how many were labelled `supported`. */
  recognised: { found: number; total: number };
}

export function summarizeMatch(scored: Scored[]): MatchSummary {
  const sup = scored.filter((s) => s.truth === "supported");
  return {
    n: scored.length,
    accuracy: scored.length ? scored.filter((s) => s.truth === s.predicted).length / scored.length : 0,
    falseSupported: scored.filter((s) => s.predicted === "supported" && s.truth !== "supported").length,
    overreach: scored.filter((s) => s.truth === "no_evidence" && s.predicted !== "no_evidence").length,
    surfaced: { found: sup.filter((s) => s.predicted !== "no_evidence").length, total: sup.length },
    recognised: { found: sup.filter((s) => s.predicted === "supported").length, total: sup.length },
  };
}

export const bySplit = (scored: Scored[]) => ({
  dev: summarizeMatch(scored.filter((s) => s.split === "dev")),
  test: summarizeMatch(scored.filter((s) => s.split === "test")),
  all: summarizeMatch(scored),
});

export interface SweepRow {
  high: number;
  low: number;
  dev: MatchSummary;
}

/** Every (high, low) pair on a grid, scored on the dev split only. */
export function sweep(signals: Signals[], from = 0.5, to = 0.85, step = 0.025): SweepRow[] {
  const dev = signals.filter((s) => s.case.split === "dev");
  const grid: number[] = [];
  for (let v = from; v <= to + 1e-9; v += step) grid.push(Number(v.toFixed(3)));
  const rows: SweepRow[] = [];
  for (const high of grid) {
    for (const low of grid) {
      if (low > high) continue;
      rows.push({ high, low, dev: summarizeMatch(score(dev, { high, low })) });
    }
  }
  return rows;
}

const pct = (x: number) => `${(100 * x).toFixed(0)}%`;
const frac = (f: { found: number; total: number }) => `${f.found}/${f.total}`;

export function formatMatching(rows: Array<{ label: string; scored: Scored[] }>): string[] {
  const out = [
    "## Requirement matching",
    "",
    "| mode | split | n | exact | false `supported` | overreach | evidence shown for supported | labelled supported |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const { label, scored } of rows) {
    const s = bySplit(scored);
    for (const split of ["dev", "test", "all"] as const) {
      const m = s[split];
      out.push(`| ${label} | ${split} | ${m.n} | ${pct(m.accuracy)} | ${m.falseSupported} | ${m.overreach} | ${frac(m.surfaced)} | ${frac(m.recognised)} |`);
    }
  }
  out.push("");
  return out;
}

/** Lists items whose verdict differs from the label, so errors can be read rather than only counted. */
export function formatMisses(label: string, scored: Scored[], items: Map<string, string>): string[] {
  const wrong = scored.filter((s) => s.truth !== s.predicted);
  if (!wrong.length) return [`${label}: no mismatches`, ""];
  return [
    `${label}: ${wrong.length} mismatch(es)`,
    ...wrong.map(
      (s) =>
        `  - [${s.split}] ${s.id}: truth ${s.truth}, got ${s.predicted} (coverage ${s.coverage.toFixed(2)}${s.similarity !== undefined ? `, similarity ${s.similarity.toFixed(3)}` : ""}) "${items.get(s.id)}"`,
    ),
    "",
  ];
}
