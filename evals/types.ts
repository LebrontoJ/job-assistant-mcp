import { z } from "zod";

const ToolRef = z.union([z.string(), z.array(z.string()).min(1)]);
const Pattern = { pattern: z.string(), flags: z.string().optional() };

export const CheckSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("calls"), tool: ToolRef, min: z.number().int().min(1).optional() }),
  z.object({ type: z.literal("not_calls"), tool: ToolRef }),
  z.object({ type: z.literal("call_order"), tools: z.array(z.string()).min(2) }),
  z.object({ type: z.literal("args"), tool: z.string(), match: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("write_gate"), allowFromTurn: z.number().int().min(0).optional() }),
  z.object({
    type: z.literal("store_has"),
    company: z.string(),
    role: z.string().optional(),
    status: z.string().optional(),
  }),
  z.object({ type: z.literal("store_lacks"), company: z.string() }),
  z.object({ type: z.literal("store_count"), company: z.string(), count: z.number().int().min(0) }),
  z.object({ type: z.literal("answer_matches"), ...Pattern }),
  z.object({ type: z.literal("answer_lacks"), ...Pattern }),
  z.object({ type: z.literal("cites"), min: z.number().int().min(0).optional() }),
  z.object({ type: z.literal("numbers_grounded") }),
  z.object({ type: z.literal("answered") }),
  z.object({ type: z.literal("judge"), rubric: z.array(z.string()).min(1) }),
]);
export type Check = z.infer<typeof CheckSchema>;

export const CATEGORIES = [
  "tool_selection",
  "arguments",
  "retrieval_use",
  "faithfulness",
  "safety",
  "edge",
  "adversarial",
] as const;

export const CaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  category: z.enum(CATEGORIES),
  description: z.string().optional(),
  /** User messages, sent one after another with history carried over. `{{file:path}}` is inlined. */
  turns: z.array(z.string()).min(1),
  checks: z.array(CheckSchema).min(1),
});
export type EvalCase = z.infer<typeof CaseSchema>;

export const RetrievalCaseSchema = z.object({
  id: z.string(),
  query: z.string(),
  /** A chunk is relevant when its source matches and its heading path contains `heading`. */
  relevant: z.array(z.object({ source: z.string(), heading: z.string() })).min(1),
  note: z.string().optional(),
});
export type RetrievalCase = z.infer<typeof RetrievalCaseSchema>;
