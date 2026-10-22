import type { Message, ToolCall } from './llm/types.js';
import { payloadHash, writePayload, type PendingOperation } from '../store/operations.js';
export const WRITE_TOOLS = ['add_application', 'update_application'];
export interface GateDecision { allowed: boolean; reason?: string; operationId?: string }
export const BLOCKED_MESSAGE = 'Blocked by the host: confirm=true needs an unexpired preview of the exact payload and explicit approval from the real user. Show the preview and wait for approval; cancellation or ambiguity never authorizes a write.';
const yes = /^(?:yes(?:,?\s*(?:please|add it|do it|go ahead|confirm))?|confirm|approve|确认|同意|确认添加|确认更新)[.!。！]?$/i;
const no = /^(?:no\b|cancel\b|reject\b|不|取消|拒绝)/i;
export function pendingOperations(messages: Message[], now = Date.now()): PendingOperation[] {
  const pending = new Map<string, PendingOperation>();
  for (const m of messages) {
    if (m.role === 'user' && !m.synthetic && (no.test(m.text.trim()) || m.approval?.decision === 'cancel')) {
      if (m.approval) pending.delete(m.approval.operationId); else pending.clear();
    }
    if (m.role !== 'tool') continue;
    for (const r of m.results) {
      if (!WRITE_TOOLS.includes(r.name) || r.isError) continue;
      try {
        const data = JSON.parse(r.text);
        if (data.status === 'pending_confirmation' && data.operation) pending.set(data.operation.id, data.operation);
        else if (data.operationId) pending.delete(data.operationId);
      } catch { /* Not a successful preview. */ }
    }
  }
  return [...pending.values()].filter(op => op.expiresAt > now);
}
export function checkWriteGate(messages: Message[], call: ToolCall, now = Date.now()): GateDecision {
  if (!WRITE_TOOLS.includes(call.name) || call.args.confirm !== true) return { allowed: true };
  const ops = pendingOperations(messages, now);
  const hash = payloadHash(call.name, writePayload(call.name, call.args));
  const matching = ops.filter(op => op.tool === call.name && op.payloadHash === hash);
  if (!matching.length) return { allowed: false, reason: 'no preview of this exact change (or it expired/cancelled)' };
  const latest = messages.findLast(m => m.role === 'user' && !m.synthetic);
  if (!latest || latest.role !== 'user') return { allowed: false, reason: 'the user has not replied with explicit approval' };
  let op: PendingOperation | undefined;
  if (latest.approval?.decision === 'approve') op = matching.find(o => o.id === latest.approval!.operationId);
  else {
    const command = latest.text.trim().match(/^\/approve\s+([\w-]+)$/);
    if (command) op = matching.find(o => o.id === command[1]);
    else if (ops.length === 1) {
      const text = latest.text.trim().toLowerCase().replace(/[.!。！]$/, "");
      const company = String(matching[0]?.payload.company ?? "").toLowerCase();
      if (yes.test(latest.text.trim()) || (company && text === `yes, add ${company}`)) op = matching[0];
    }
  }
  if (!op) return { allowed: false, reason: 'the user has not replied with explicit, unambiguous approval' };
  // Approval must follow the particular preview, never precede it.
  const userAt = messages.indexOf(latest);
  const previewAt = messages.findLastIndex(m => m.role === 'tool' && m.results.some(r => {
    try { return JSON.parse(r.text).operation?.id === op!.id; } catch { return false; }
  }));
  if (userAt <= previewAt) return { allowed: false, reason: 'the user has not replied since this preview' };
  if (call.args.operationId && call.args.operationId !== op.id) return { allowed: false, reason: 'operation id differs from approval' };
  return { allowed: true, operationId: op.id };
}
