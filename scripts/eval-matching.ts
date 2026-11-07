import { writeFile } from 'node:fs/promises';
import { createMatching } from '../src/matching/factory.js';
import { ModeSchema, digest, MATCH_VERSION, type MatchMode } from '../src/matching/types.js';
import { evaluateMatchingCase, loadMatchingCases, summarizeMatching } from '../evals/resume-matching.js';
const args = process.argv.slice(2);
const value = (flag: string) => args.find(a => a.startsWith(`--${flag}=`))?.slice(flag.length + 3);
const live = args.includes('--live');
if (live) { try { process.loadEnvFile('.env'); } catch { /* real environment */ } }
const split = value('split') ?? 'dev';
if (split !== 'dev' && split !== 'heldout') throw new Error('split must be dev or heldout');
const limit = Number(value('limit') ?? Number.MAX_SAFE_INTEGER);
const repeat = Number(value('repeat') ?? 1);
if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(repeat) || repeat < 1 || repeat > 10) throw new Error('Use positive limit and repeat 1..10');
const modes: MatchMode[] = value('mode') ? [ModeSchema.parse(value('mode'))] : live ? ['retrieval', 'assessment', 'agent'] : ['retrieval'];
if (!live && modes.some(m => m !== 'retrieval')) throw new Error('Model modes require explicit --live');
const matching = live && modes.some(mode => mode !== 'retrieval')
  ? createMatching({ ...process.env, MATCH_MODE: 'assessment', MATCH_CACHE: 'off' }) : {};
const llm = matching.llm;
const cases = (await loadMatchingCases(split)).slice(0, limit);
const results = [];
for (let sample = 0; sample < repeat; sample++) for (const c of cases) for (const mode of modes) {
  const row = await evaluateMatchingCase(c, mode, matching);
  results.push({ sample, ...row });
  console.error(`${sample + 1}/${repeat} ${mode} ${c.id}: ${row.predicted ?? 'unassessed'}${row.error ? ' ERROR' : ''}`);
}
const byMode = Object.fromEntries(modes.map(mode => [mode, summarizeMatching(results.filter(r => r.mode === mode))]));
const assessmentRows = results.filter(r => r.mode === 'assessment');
const agentRows = results.filter(r => r.mode === 'agent');
const paired = agentRows.flatMap(agent => {
  const baseline = assessmentRows.find(r => r.id === agent.id && r.sample === agent.sample);
  return baseline ? [{ id: agent.id, sample: agent.sample, recovered: !baseline.exact && agent.exact, regressed: baseline.exact && !agent.exact }] : [];
});
const report = { date: new Date().toISOString(), version: MATCH_VERSION, split, repeat, casesHash: digest(cases), live,
  provider: llm?.provider, model: llm?.model, cache: 'disabled',
  configuration: { totalMs: matching.totalMs, callMs: matching.callMs, maxRounds: matching.maxRounds, maxSearches: matching.maxSearches },
  scope: 'Synthetic author-labelled fixtures; retrieval verdicts are a label projection; goldEvidenceOverlap is a source/quote overlap proxy, not semantic citation accuracy. No live improvement claim from scripted tests.',
  byMode, supplemental: { paired: paired.length, recovered: paired.filter(p => p.recovered).length, regressed: paired.filter(p => p.regressed).length }, results };
console.log(JSON.stringify(report, null, 2));
if (value('output')) await writeFile(value('output')!, JSON.stringify(report, null, 2) + '\n');
if (results.some(r => r.error)) process.exitCode = 2;
