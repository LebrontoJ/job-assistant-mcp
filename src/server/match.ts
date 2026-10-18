import type { ProfileIndex } from "../rag/index.js";
import { tokenize } from "../rag/tokenize.js";
import type { ParsedJd } from "./jd.js";

export type Support = "supported" | "weak" | "no_evidence";

export interface Evidence {
  chunkId: string;
  heading: string;
  excerpt: string;
}

export interface ItemMatch {
  kind: "requirement" | "nice_to_have";
  item: string;
  support: Support;
  /** Share of the item's terms found in the best chunk. A lexical signal, not a judgement. */
  coverage: number;
  evidence: Evidence[];
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

const excerpt = (text: string, n = 160) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/**
 * Compares a parsed JD to the profile using retrieval only. It reports where evidence exists
 * (with chunk ids to cite) and where it does not; deciding what that means is left to the caller.
 */
export async function matchProfile(jd: ParsedJd, index: ProfileIndex): Promise<MatchReport> {
  const wanted: Array<Pick<ItemMatch, "kind" | "item">> = [
    ...jd.requirements.map((item) => ({ kind: "requirement" as const, item })),
    ...jd.niceToHave.map((item) => ({ kind: "nice_to_have" as const, item })),
  ];

  const items: ItemMatch[] = [];
  for (const { kind, item } of wanted) {
    const hits = await index.search(item, 3);
    const best = hits.reduce((a, h) => (h.coverage > a ? h.coverage : a), 0);
    const support: Support = best >= SUPPORTED ? "supported" : best >= WEAK ? "weak" : "no_evidence";
    items.push({
      kind,
      item,
      support,
      coverage: Number(best.toFixed(2)),
      evidence:
        support === "no_evidence"
          ? []
          : hits
              .filter((h) => h.coverage >= WEAK)
              .map((h) => ({ chunkId: h.chunk.id, heading: h.chunk.heading, excerpt: excerpt(h.chunk.text) })),
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
    note:
      "Support is based on word overlap with the profile, so numeric requirements (years of experience) " +
      "and paraphrases can be misjudged. Treat 'no_evidence' as 'not found in the profile', not as 'candidate lacks it'.",
  };
}
