import type { ProfileIndex } from "../rag/index.js";
import { tokenize } from "../rag/tokenize.js";
import type { ParsedJd } from "./jd.js";

export type Support = "supported" | "weak" | "no_evidence";

export interface Evidence {
  chunkId: string;
  heading: string;
  excerpt: string;
  /** Why this passage was offered: shared words, embedding similarity, or both. */
  matchedBy: "keyword" | "semantic" | "keyword+semantic";
}

export interface ItemMatch {
  kind: "requirement" | "nice_to_have";
  item: string;
  support: Support;
  /** Share of the item's terms found in the best chunk. A lexical signal, not a judgement. */
  coverage: number;
  /** Best embedding similarity among the retrieved passages; present only when a dense retriever is configured. */
  similarity?: number;
  evidence: Evidence[];
  /** Why the verdict was capped or how to read it. */
  note?: string;
}

export interface SkillMatch {
  skill: string;
  found: boolean;
  chunkIds: string[];
}

export interface MatchReport {
  items: ItemMatch[];
  skills: SkillMatch[];
  summary: { requirements: Record<Support, number>; skillsFound: number; skillsMissing: string[] };
  note: string;
}

const SUPPORTED = 0.5;
const WEAK = 0.25;

/** Thresholds for the embedding signal. Omit them to judge by word overlap alone. */
export interface SemanticThresholds {
  /** With at least some keyword overlap, a similarity this high upgrades `weak` to `supported`. */
  high: number;
  /** Without any keyword overlap, a similarity this high makes a passage worth showing, as `weak` at most. */
  low: number;
}

export interface MatchOptions {
  semantic?: SemanticThresholds;
}

/** The retrieved passage sharing the largest fraction of the query's words (first wins ties). */
export function bestByCoverage<T extends { coverage: number }>(hits: T[]): T | undefined {
  let best: T | undefined;
  for (const h of hits) if (!best || h.coverage > best.coverage) best = h;
  return best;
}

const excerpt = (text: string, n = 160) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/** "5+ years", "at least 3 ...": a quantity that matching words cannot verify. */
export const isQuantitative = (item: string): boolean =>
  /\b\d+\s*\+?\s*(?:years?|yrs?|months?)\b|\bat least\s+\d+|\b\d+\s*\+/i.test(item);

export interface SupportSignals {
  coverage: number;
  /** Query terms found in the best passage, out of `terms`. */
  matched: number;
  terms: number;
  similarity?: number;
  quantitative: boolean;
}

/**
 * Turns the retrieval signals into a verdict. The embedding signal can only ever add `weak`, or lift `weak` to
 * `supported` when words overlap too, because similarity alone cannot tell "Rust" from "backend experience" (measured:
 * an absent skill scored higher than some genuine matches). A false `supported` is worse than a missed one.
 */
export function decideSupport(sig: SupportSignals, semantic?: SemanticThresholds): { support: Support; note?: string } {
  // One shared word out of two ("api" in "REST APIs") is not evidence: with two or more terms, two must match.
  const enoughTerms = sig.matched >= Math.min(2, sig.terms);
  let support: Support = sig.coverage >= SUPPORTED && enoughTerms ? "supported" : sig.coverage >= WEAK ? "weak" : "no_evidence";
  if (semantic && sig.similarity !== undefined) {
    if (sig.coverage >= WEAK && enoughTerms && sig.similarity >= semantic.high) support = "supported";
    else if (support === "no_evidence" && sig.similarity >= semantic.low) support = "weak";
  }
  if (sig.quantitative && support === "supported") {
    return { support: "weak", note: "Contains a quantity (e.g. years) that retrieval cannot verify; check it against the dates in the profile." };
  }
  return { support };
}

/**
 * Compares a parsed JD to the profile using retrieval only. It reports where evidence exists
 * (with chunk ids to cite) and where it does not; deciding what that means is left to the caller.
 */
export async function matchProfile(jd: ParsedJd, index: ProfileIndex, opts: MatchOptions = {}): Promise<MatchReport> {
  const semantic = index.hybrid ? opts.semantic : undefined;
  const wanted: Array<Pick<ItemMatch, "kind" | "item">> = [
    ...jd.requirements.map((item) => ({ kind: "requirement" as const, item })),
    ...jd.niceToHave.map((item) => ({ kind: "nice_to_have" as const, item })),
  ];

  const items: ItemMatch[] = [];
  for (const { kind, item } of wanted) {
    const hits = await index.search(item, 3);
    const best = bestByCoverage(hits);
    const coverage = best?.coverage ?? 0;
    const sims = hits.flatMap((h) => (h.similarity === undefined ? [] : [h.similarity]));
    const similarity = sims.length ? Math.max(...sims) : undefined;
    const { support, note } = decideSupport({ coverage, matched: best?.matched ?? 0, terms: best?.terms ?? 0, similarity, quantitative: isQuantitative(item) }, semantic);

    const evidence: Evidence[] =
      support === "no_evidence"
        ? []
        : hits.flatMap((h) => {
            const kw = h.coverage >= WEAK;
            const sem = semantic !== undefined && (h.similarity ?? 0) >= semantic.low;
            if (!kw && !sem) return [];
            const matchedBy = kw && sem ? "keyword+semantic" : kw ? "keyword" : "semantic";
            return [{ chunkId: h.chunk.id, heading: h.chunk.heading, excerpt: excerpt(h.chunk.text), matchedBy } as Evidence];
          });

    items.push({
      kind,
      item,
      support,
      coverage: Number(coverage.toFixed(2)),
      ...(similarity !== undefined ? { similarity: Number(similarity.toFixed(3)) } : {}),
      evidence,
      ...(note ? { note } : {}),
    });
  }

  const skills: SkillMatch[] = jd.skills.map((skill) => {
    const need = tokenize(skill);
    const chunkIds = index.chunks
      .filter((c) => {
        const have = new Set(tokenize(`${c.heading} ${c.text}`));
        return need.length > 0 && need.every((t) => have.has(t));
      })
      .map((c) => c.id);
    return { skill, found: chunkIds.length > 0, chunkIds };
  });

  const reqs = items.filter((i) => i.kind === "requirement");
  const count = (s: Support) => reqs.filter((i) => i.support === s).length;
  return {
    items,
    skills,
    summary: {
      requirements: { supported: count("supported"), weak: count("weak"), no_evidence: count("no_evidence") },
      skillsFound: skills.filter((s) => s.found).length,
      skillsMissing: skills.filter((s) => !s.found).map((s) => s.skill),
    },
    note: semantic
      ? "Support combines word overlap with embedding similarity. Similarity alone never makes an item 'supported' and a " +
        "quantity (years) is never verified, so read 'weak' as 'related passage, check it'. Treat 'no_evidence' as " +
        "'not found in the profile', not as 'candidate lacks it'."
      : "Support is based on word overlap with the profile, so numeric requirements (years of experience) " +
        "and paraphrases can be misjudged. Treat 'no_evidence' as 'not found in the profile', not as 'candidate lacks it'.",
  };
}
