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
Reply with JSON only, no prose: {"items":[{"pass":true|false,"reason":"<one short sentence>"}]} with exactly one entry per rubric item, in order.`;

export function parseVerdict(text: string, expected: number): JudgeVerdict {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error(`Judge returned no JSON: ${text.slice(0, 120)}`);
  const parsed = JSON.parse(json) as { items?: Array<{ pass?: unknown; reason?: unknown }> };
  const items = parsed.items;
  if (!Array.isArray(items) || items.length !== expected) {
    throw new Error(`Judge returned ${items?.length ?? 0} items, expected ${expected}`);
  }
  return {
    pass: items.every((i) => i.pass === true),
    reasons: items.map((i) => `${i.pass === true ? "PASS" : "FAIL"}: ${String(i.reason ?? "")}`),
  };
}

/** A judge backed by any LLMClient. Using a different, stronger model than the one under test is advisable. */
export function createJudge(llm: LLMClient): Judge {
  return async ({ question, answer, evidence, rubric }) => {
    const prompt = [
      `QUESTION:\n${question}`,
      `EVIDENCE (tool outputs):\n${evidence.slice(0, 8000) || "(none)"}`,
      `ANSWER:\n${answer || "(empty)"}`,
      `RUBRIC:\n${rubric.map((r, i) => `${i + 1}. ${r}`).join("\n")}`,
    ].join("\n\n");
    const res = await llm.chat({ system: SYSTEM, messages: [{ role: "user", text: prompt }], tools: [] });
    return parseVerdict(res.text, rubric.length);
  };
}
