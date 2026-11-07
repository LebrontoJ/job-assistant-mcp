import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CaseSchema, ProfileSchema, type E2ECase, type E2EProfile, type Split } from './types.js';
export const fixtureRoot = new URL('./fixtures/', import.meta.url);
export const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
export const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => JSON.stringify(k)+':'+canonical(v)).join(',') + '}';
  return JSON.stringify(value);
};
export async function verifyFixtures(): Promise<Record<string,string>> {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', fixtureRoot), 'utf8')) as { files: Record<string,string> };
  for (const [file, expected] of Object.entries(manifest.files)) {
    if (file.includes('..') || file.startsWith('/')) throw new Error('Invalid manifest path');
    if (hash(await readFile(new URL(file, fixtureRoot))) !== expected) throw new Error(`Frozen fixture hash mismatch: ${file}`);
  }
  return manifest.files;
}
export async function loadCases(split: Split): Promise<Array<{ task: E2ECase; profile: E2EProfile }>> {
  await verifyFixtures();
  const tasks = (await readFile(new URL(`cases/${split}.jsonl`, fixtureRoot), 'utf8')).trim().split('\n').map(l => CaseSchema.parse(JSON.parse(l)));
  const seen = new Set<string>();
  const result = [];
  for (const task of tasks) {
    if (task.split !== split || seen.has(task.id) || !/^[\w-]+$/.test(task.profileId)) throw new Error('Invalid case identity/split');
    seen.add(task.id);
    const profile = ProfileSchema.parse(JSON.parse(await readFile(new URL(`profiles/${task.profileId}.json`, fixtureRoot), 'utf8')));
    if (profile.id !== task.profileId || profile.split !== split) throw new Error('Profile crosses splits');
    for (const [path] of Object.entries(profile.documents)) if (path.startsWith('/') || path.split(/[\\/]/).includes('..')) throw new Error('Invalid profile path');
    for (const ref of [...task.gold.facts, ...task.gold.requirements.flatMap(r => r.evidence)]) if (!profile.documents[ref.source]?.includes(ref.quote)) throw new Error(`Missing gold quote: ${task.id}`);
    result.push({ task, profile });
  }
  return result;
}
