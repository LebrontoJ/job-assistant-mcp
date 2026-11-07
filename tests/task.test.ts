import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { connectedPair } from './helpers.js';
import { analyseTask } from '../src/agent/task.js';
describe('structured JD task', () => {
  it('produces requirements, full evidence and citable drafts without writes', async () => {
    const { client, store } = await connectedPair();
    try {
      const before = await store.list();
      const report = await analyseTask(client, readFileSync('data/sample/jd-backend.txt', 'utf8'));
      expect(report.requirements.length).toBeGreaterThan(0);
      expect(report.evidence.length).toBeGreaterThan(0);
      expect(report.draft.rewrites.length).toBeGreaterThan(0);
      for (const rewrite of report.draft.rewrites) expect(report.evidence.some(e => e.id === rewrite.evidenceIds[0] && e.text.includes(rewrite.text))).toBe(true);
      expect(await store.list()).toEqual(before);
    } finally { await client.close(); }
  });
});

  it('uses assessed evidence for drafts and keeps matching read-only', async () => {
    const { client, store } = await connectedPair();
    try {
      const report = await analyseTask(client, 'Backend Engineer\nRequirements:\n- Python/FastAPI services', {
        matching: { mode: 'assessment', llm: { provider: 'test', model: 'assessor', chat: async req => {
          const input = JSON.parse((req.messages[0] as { text: string }).text);
          return { text: JSON.stringify({ items: input.requirements.map((r: any) => ({ requirementId: r.id, criteria: r.criteria.map((c: any) => ({ criterionId: c.id, verdict: 'supported', evidence: [{ sourceId: input.sources[0].id, quote: input.sources[0].text.split('\n')[0] }], reason: 'Services explicitly described', missingInformation: [] })) })) }), toolCalls: [], finish: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
        } } },
      });
      expect(report.assessment.summary.requirement).toMatchObject({ assessed: 1, supported: 1 });
      expect(report.draft.rewrites.length).toBeGreaterThan(0);
      expect(report.draft.rewrites.every(c => report.assessment.sources.some(s => s.id === c.evidenceIds[0]))).toBe(true);
      expect(await store.list()).toHaveLength(4);
    } finally { await client.close(); }
  });

  it('retains completed judgments when drafting later fails', async () => {
    const { client } = await connectedPair();
    try {
      const report = await analyseTask(client, 'Backend Engineer\nRequirements:\n- Python/FastAPI services', {
        matching: { mode: 'assessment', llm: { provider: 'test', model: 'assessor', chat: async req => {
          const input = JSON.parse((req.messages[0] as { text: string }).text);
          return { text: JSON.stringify({ items: input.requirements.map((r: any) => ({ requirementId: r.id, criteria: r.criteria.map((c: any) => ({ criterionId: c.id, verdict: 'supported', evidence: [{ sourceId: input.sources[0].id, quote: input.sources[0].text.split('\n')[0] }], reason: 'Direct evidence', missingInformation: [] })) })) }), toolCalls: [], finish: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
        } } },
        llm: { provider: 'test', model: 'draft-unavailable', chat: async () => { throw new Error('provider unavailable'); } },
      });
      expect(report.assessment.items[0]?.verdict).toBe('supported');
      expect(report.draftStatus).toBe('unavailable');
      expect(report.draft.rewrites).toEqual([]);
    } finally { await client.close(); }
  });
