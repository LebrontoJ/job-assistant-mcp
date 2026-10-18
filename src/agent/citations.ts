import type { Message } from "./llm/types.js";
import type { ToolTrace } from "./loop.js";

const CITE = /([\w./-]+\.md#\d+)/g;

export const citedIds = (text: string): string[] => [...new Set([...text.matchAll(CITE)].map((m) => m[1]!))];

interface Evidence {
  /** Every passage id any retrieval tool returned. */
  all: Set<string>;
  /** Ids from passages that matched the query well (so an answer using them should cite them). */
  strong: Set<string>;
}

const STRONG_COVERAGE = 0.5;

function collect(results: Array<{ name: string; text: string }>): Evidence {
  const ev: Evidence = { all: new Set(), strong: new Set() };
  for (const r of results) {
    let j: any;
    try {
      j = JSON.parse(r.text);
    } catch {
      continue;
    }
    if (r.name === "search_profile") {
      for (const h of j?.hits ?? []) {
        if (typeof h?.id !== "string") continue;
        ev.all.add(h.id);
        if ((h.keywordCoverage ?? 0) >= STRONG_COVERAGE) ev.strong.add(h.id);
      }
    } else if (r.name === "match_resume") {
      for (const item of j?.items ?? []) {
        for (const e of item?.evidence ?? []) {
          if (typeof e?.chunkId !== "string") continue;
          ev.all.add(e.chunkId);
          if (item.support === "supported") ev.strong.add(e.chunkId);
        }
      }
    }
  }
  return ev;
}

export const evidenceFromMessages = (messages: Message[]): Evidence =>
  collect(messages.flatMap((m) => (m.role === "tool" ? m.results : [])));

export const evidenceFromTrace = (trace: ToolTrace[]): Evidence =>
  collect(trace.map((t) => ({ name: t.name, text: t.result })));

/**
 * Runtime citation check on a final answer. Two things are flagged: a cited id no tool ever returned (fabricated),
 * and an answer that cites nothing although this turn retrieved passages that matched strongly (uncited claims).
 * A "nothing found" answer is not penalised: weak or empty retrieval never triggers the second case.
 */
export function citationProblem(answer: string, messages: Message[], turnTrace: ToolTrace[]): string | undefined {
  const cited = citedIds(answer);
  const known = evidenceFromMessages(messages).all;
  const unknown = cited.filter((id) => !known.has(id));
  if (unknown.length) {
    return `You cited ${unknown.join(", ")}, which no tool returned. Cite only passage ids that appear in search_profile or match_resume results, or remove the citation.`;
  }
  if (cited.length === 0 && evidenceFromTrace(turnTrace).strong.size > 0) {
    return "Your answer draws on the profile search results but cites no passage ids. Rewrite it citing the passage id in square brackets after each claim, e.g. [resume.md#0]. Do not add new claims.";
  }
  return undefined;
}
