import type { LLMClient } from "../src/agent/llm/types.js";

export interface JudgeInput {
  question: string;
  answer: string;
  /** Tool outputs the assistant had access to: the only ground truth for factual claims. */
  evidence: string;
  rubric: string[];
}
export interface JudgeVerdict {
  pass: boolean;
  reasons: string[];
}
export type Judge = (input: JudgeInput) => Promise<JudgeVerdict>;

const SYSTEM = `You grade an AI assistant's answer against a rubric. Be strict and literal.
- The EVIDENCE is the only source of truth about the user. A claim about the user that EVIDENCE does not support, or that changes a number, date or scope from it, fails.
- Grade each rubric item independently as pass or fail.
Reply with JSON only, no prose and no code fence: {"items":[{"pass":true|false,"reason":"<one short sentence>"}]} with exactly one entry per rubric item, in order.`;

/** First balanced JSON object or array in `text`, ignoring braces inside strings. */
function firstJson(text: string): string | undefined {
  const start = text.search(/[\[{]/);
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if ((c === "}" || c === "]") && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}

type Item = { pass?: unknown; reason?: unknown };

/**
 * Judges drift in format between models: some answer {"items":[...]}, others a bare array, others wrap it in a
 * code fence or add prose. All of those are accepted; what is not negotiable is one verdict per rubric item.
 */
export function parseVerdict(text: string, expected: number): JudgeVerdict {
  const json = firstJson(text);
  if (!json) throw new Error(`Judge returned no JSON: ${text.slice(0, 120)}`);
  const parsed = JSON.parse(json) as Item[] | { items?: Item[] } | Item;
  const items: Item[] | undefined = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { items?: Item[] }).items)
      ? (parsed as { items: Item[] }).items
      : "pass" in parsed
        ? [parsed as Item]
        : undefined;
  if (!items || items.length !== expected) {
    throw new Error(`Judge returned ${items?.length ?? 0} items, expected ${expected}`);
  }
  return {
    pass: items.every((i) => i.pass === true),
    reasons: items.map((i) => `${i.pass === true ? "PASS" : "FAIL"}: ${String(i.reason ?? "")}`),
  };
}

/**
 * A judge backed by any LLMClient. Using a different model from the one under test is advisable. If the reply is
 * not a usable verdict, it asks once more, quoting the bad reply: the request must differ or a response cache would
 * hand back the same bad answer.
 */
export function createJudge(llm: LLMClient): Judge {
  return async ({ question, answer, evidence, rubric }) => {
    const prompt = [
      `QUESTION:\n${question}`,
      `EVIDENCE (tool outputs):\n${evidence.slice(0, 8000) || "(none)"}`,
      `ANSWER:\n${answer || "(empty)"}`,
      `RUBRIC:\n${rubric.map((r, i) => `${i + 1}. ${r}`).join("\n")}`,
    ].join("\n\n");
    const first = await llm.chat({ system: SYSTEM, messages: [{ role: "user", text: prompt }], tools: [] });
    try {
      return parseVerdict(first.text, rubric.length);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const retry = await llm.chat({
        system: SYSTEM,
        messages: [
          { role: "user", text: prompt },
          { role: "assistant", text: first.text, toolCalls: [] },
          {
            role: "user",
            text: `That reply could not be used (${reason}). Reply again with valid JSON only, in exactly this shape: {"items":[{"pass":true,"reason":"..."}]} with ${rubric.length} item(s).`,
            synthetic: true,
          },
        ],
        tools: [],
      });
      return parseVerdict(retry.text, rubric.length);
    }
  };
}
