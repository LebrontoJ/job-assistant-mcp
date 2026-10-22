import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const files = execFileSync('git', ['ls-files', 'src', 'evals/cases', 'evals/retrieval.jsonl', 'evals/match.jsonl', 'pnpm-lock.yaml'], { encoding: 'utf8' }).trim().split('\n');
const manifest = {
  schemaVersion: 1, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  node: process.version, capturedAt: new Date().toISOString(),
  files: Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')])),
  liveRun: false, liveReference: 'docs/EVALS.md, row 6 (historical, not a new run)',
  liveConfig: { provider: 'gemini', model: 'gemini-3.1-flash-lite', judge: 'gemini-3.5-flash-lite', repeat: 3, embeddings: 'none' },
};
writeFileSync(process.argv[2] ?? 'evals/baselines/01/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
