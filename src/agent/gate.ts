import type { Message, ToolCall } from "./llm/types.js";

export const WRITE_TOOLS = ["add_application", "update_application"];

export interface GateDecision {
  allowed: boolean;
  reason?: string;
}

export const BLOCKED_MESSAGE =
  "Blocked by the host: confirm=true is only accepted after a preview of this exact change was returned and the " +
  "user has replied since. Call the tool without confirm, show the user the preview, and wait for their answer.";

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();

/** Which row a preview result is about: add -> company+role, update -> id. */
function previewTarget(tool: string, result: unknown): string | undefined {
  const r = result as { status?: string; preview?: Record<string, unknown>; current?: Record<string, unknown> } | null;
  if (r?.status !== "pending_confirmation") return undefined;
  if (tool === "add_application") return `${norm(r.preview?.company)}|${norm(r.preview?.role)}`;
  return norm(r.current?.id);
}

function callTarget(call: ToolCall): string {
  return call.name === "add_application"
    ? `${norm(call.args.company)}|${norm(call.args.role)}`
    : norm(call.args.id);
}

/**
 * Host-side enforcement of "preview first, write after the user answers". The MCP server cannot tell who set
 * `confirm`, so the agent host checks the conversation instead: a confirmed write is allowed only if an earlier tool
 * result previewed the same change AND a real (non-synthetic) user message came after that preview.
 *
 * It proves a human turn happened in between, not that the human said yes; a "no" followed by a confirmed write
 * still passes this gate (the evals' outcome checks catch that).
 */
export function checkWriteGate(messages: Message[], call: ToolCall): GateDecision {
  if (!WRITE_TOOLS.includes(call.name) || call.args.confirm !== true) return { allowed: true };
  const target = callTarget(call);

  let previewAt = -1;
  messages.forEach((m, i) => {
    if (m.role !== "tool") return;
    for (const r of m.results) {
      if (r.name !== call.name || r.isError) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.text);
      } catch {
        continue;
      }
      if (previewTarget(call.name, parsed) === target) previewAt = i;
    }
  });
  if (previewAt === -1) return { allowed: false, reason: "no preview of this change in the conversation" };

  const answered = messages.slice(previewAt + 1).some((m) => m.role === "user" && !m.synthetic);
  return answered ? { allowed: true } : { allowed: false, reason: "the user has not replied since the preview" };
}
