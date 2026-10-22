import { createHash, randomUUID } from 'node:crypto';
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
export function writePayload(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const { confirm, operationId, ...payload } = args;
  if (tool === 'add_application') return { ...payload, company: String(payload.company ?? '').trim(), role: String(payload.role ?? '').trim(), status: payload.status ?? 'wishlist' };
  return payload;
}
export const payloadHash = (tool: string, payload: unknown): string => createHash('sha256').update(canonical({ tool, payload })).digest('hex');
export interface PendingOperation { id: string; tool: string; payload: Record<string, unknown>; payloadHash: string; expiresAt: number; expectedVersion?: number }
export function newOperation(tool: string, args: Record<string, unknown>, expectedVersion?: number, now = Date.now()): PendingOperation {
  const payload = writePayload(tool, args);
  return { id: randomUUID(), tool, payload, payloadHash: payloadHash(tool, payload), expiresAt: now + 10 * 60_000, ...(expectedVersion !== undefined ? { expectedVersion } : {}) };
}
export function assertOperation(op: PendingOperation | undefined, tool: string, args: Record<string, unknown>, now = Date.now()): asserts op is PendingOperation {
  if (!op) throw new Error('PREVIEW_REQUIRED: unknown operation; request a preview first.');
  if (op.expiresAt <= now) throw new Error('APPROVAL_EXPIRED: request a fresh preview.');
  if (op.payloadHash !== payloadHash(tool, writePayload(tool, args))) throw new Error('PAYLOAD_CHANGED: approved preview does not match this write.');
}
