import { describe, it, expect } from 'vitest';
import { checkWriteGate } from '../src/agent/gate.js';
import { newOperation } from '../src/store/operations.js';
import { connectedPair, textOf } from './helpers.js';
import type { Message } from '../src/agent/llm/types.js';
const args = { company: 'Acme', role: 'SWE', notes: 'original' };
const op = newOperation('add_application', args);
const history: Message[] = [{ role: 'tool', results: [{ callId: '1', name: 'add_application', text: JSON.stringify({ status: 'pending_confirmation', operation: op }) }] }];
const call = { id: '2', name: 'add_application', args: { ...args, confirm: true } };
describe('exact host approval', () => {
  for (const answer of ['no', 'no, do not add it', 'maybe', 'yes but change the notes', 'ok I have a question']) it(`blocks ${answer}`, () => {
    expect(checkWriteGate([...history, { role: 'user', text: answer }], call).allowed).toBe(false);
  });
  it('binds approval to every field and rejects expired or cancelled approvals', () => {
    const approved: Message[] = [...history, { role: 'user', text: `/approve ${op.id}` }];
    expect(checkWriteGate(approved, call).allowed).toBe(true);
    expect(checkWriteGate(approved, { ...call, args: { ...call.args, notes: 'changed' } }).allowed).toBe(false);
    expect(checkWriteGate(approved, call, op.expiresAt).allowed).toBe(false);
    expect(checkWriteGate([...history, { role: 'user', text: 'no' }, { role: 'user', text: 'yes' }], call).allowed).toBe(false);
  });
  it('does not let the server execute an absent or changed preview', async () => {
    const { client, store } = await connectedPair();
    try {
      expect((await client.callTool({ name: 'add_application', arguments: call.args })).isError).toBe(true);
      const preview = JSON.parse(textOf(await client.callTool({ name: 'add_application', arguments: args })));
      expect((await client.callTool({ name: 'add_application', arguments: { ...call.args, notes: 'changed', operationId: preview.operation.id } })).isError).toBe(true);
      expect(await store.list({ company: 'Acme' })).toHaveLength(0);
    } finally { await client.close(); }
  });
});
