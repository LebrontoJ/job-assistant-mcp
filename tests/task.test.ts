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
