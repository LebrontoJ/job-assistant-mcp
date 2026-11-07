import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { loadCases, fixtureRoot, verifyFixtures } from '../evals/e2e/load.js';
import { GoldSchema } from '../evals/e2e/types.js';
describe('e2e candidate data', () => {
  it('verifies frozen bytes without evaluating heldout labels', async () => {
    const files = await verifyFixtures(); expect(Object.keys(files)).toHaveLength(9);
    const dev = await loadCases('dev'); expect(dev).toHaveLength(15);
    expect(new Set(dev.map(c => c.profile.id)).size).toBe(3);
    expect(dev.every(c => c.task.provenance.reviewStatus === 'pending')).toBe(true);
  });
  it('keeps source/template families within their assigned split', async () => {
    // Check only routing metadata across splits, not heldout semantic expectations.
    const profiles = new Map<string,string>(), families = new Map<string,string>();
    for (const split of ['dev','validation','heldout']) for (const line of (await readFile(new URL(`cases/${split}.jsonl`, fixtureRoot), 'utf8')).trim().split('\n')) {
      const { profileId, jdFamily, split: declared } = JSON.parse(line);
      expect(declared).toBe(split);
      for (const [map,key] of [[profiles,profileId],[families,jdFamily]] as const) { expect(map.get(key) ?? split).toBe(split); map.set(key,split); }
    }
    expect(profiles.size).toBe(6);
  });
  it('does not allow positive rubrics to declare an empty draft successful', async () => {
    const { task } = (await loadCases('dev'))[0]!;
    expect(GoldSchema.safeParse({ ...task.gold, minimumDraftFacts: 0 }).success).toBe(false);
  });
});
