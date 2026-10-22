import { readFile } from 'node:fs/promises';
import { validateClaim } from '../src/agent/grounding.js';
const split = process.argv[2] ?? 'dev';
if (!['dev', 'heldout'].includes(split)) throw new Error('Use dev or heldout.');
const cases = (await readFile(`evals/regression/${split}/claims.jsonl`, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
let passed = 0, total = 0;
for (const c of cases) {
  if (c.kind === 'suggestion') continue; // Suggestions are future actions, not factual entailment claims.
  total++;
  const verdict = await validateClaim({ text: c.claim, evidenceIds: ['fixture.md#0'] }, [{ id: 'fixture.md#0', source: 'fixture.md', heading: '', text: c.source }]);
  const correct = verdict.supported === (c.kind === 'supported');
  if (correct) passed++;
  console.log(JSON.stringify({ id: c.id, correct, supported: verdict.supported, reason: verdict.reason }));
}
console.log(JSON.stringify({ split, passed, total, scope: 'offline host rules only; not a live-model metric' }));
if (passed !== total) process.exitCode = 1;
