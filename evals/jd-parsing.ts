import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJdParser } from '../src/parsing/factory.js';
import { JdParsingService } from '../src/parsing/service.js';
import type { JdParser, JdParseResult } from '../src/parsing/types.js';
import type { ParsedJd } from '../src/server/jd.js';
import { percentile } from '../src/agent/trace.js';
import { jdParsingCases } from './jd-parsing-cases.js';
const scalarFields = ['title', 'company', 'location', 'workMode', 'minYearsExperience'] as const;
const listFields = ['requirements', 'niceToHave', 'responsibilities', 'skills'] as const;
// Ignore punctuation and whitespace differences while preserving wording; this is not a semantic judge.
const norm = (s: unknown) => typeof s === 'string' ? s.normalize('NFKC').toLowerCase().replace(/[\s.,;:!?，。；：！？]+/g, '').trim() : s;
export function scoreJd(actual: ParsedJd, expected: ParsedJd) {
  const scalarCorrect = scalarFields.filter(f => norm(actual[f]) === norm(expected[f])).length;
  const lists = Object.fromEntries(listFields.map(field => {
    const a = new Set(actual[field].map(norm)), e = new Set(expected[field].map(norm));
    return [field, { correct: [...a].filter(v => e.has(v)).length, predicted: a.size, expected: e.size }];
  })) as Record<typeof listFields[number], { correct: number; predicted: number; expected: number }>;
  return { scalarCorrect, scalarTotal: scalarFields.length, lists };
}
function summarize(rows: Array<{ result: JdParseResult; score: ReturnType<typeof scoreJd> }>) {
  const scalarCorrect = rows.reduce((n, r) => n + r.score.scalarCorrect, 0), scalarTotal = rows.reduce((n, r) => n + r.score.scalarTotal, 0);
  return { cases: rows.length, scalarCorrect, scalarTotal, scalarAccuracy: scalarTotal ? scalarCorrect / scalarTotal : null,
    lists: Object.fromEntries(listFields.map(field => {
      const counts = rows.reduce((n, r) => ({ correct: n.correct + r.score.lists[field].correct, predicted: n.predicted + r.score.lists[field].predicted, expected: n.expected + r.score.lists[field].expected }), { correct: 0, predicted: 0, expected: 0 });
      return [field, { ...counts, precision: counts.predicted ? counts.correct / counts.predicted : null, recall: counts.expected ? counts.correct / counts.expected : null }];
    })),
    fallbackCases: rows.filter(r => r.result.meta.fallbackReason).length,
    evidenceRejectedCases: rows.filter(r => r.result.meta.fallbackReason === 'unsupported_evidence').length,
    apiCalls: rows.reduce((n, r) => n + r.result.meta.apiCalls, 0), inputTokens: rows.reduce((n, r) => n + r.result.meta.inputTokens, 0), outputTokens: rows.reduce((n, r) => n + r.result.meta.outputTokens, 0),
    p50Ms: percentile(rows.map(r => r.result.meta.ms), 50) ?? null, p95Ms: percentile(rows.map(r => r.result.meta.ms), 95) ?? null,
  };
}
async function evaluate(parser: JdParser, cases: typeof jdParsingCases) {
  const rows = [];
  for (const c of cases) {
    const result = await parser.parse(c.text);
    rows.push({ id: c.id, result, score: scoreJd(result.data, c.expected) });
  }
  return { endToEnd: summarize(rows), apiSuccessOnly: summarize(rows.filter(r => r.result.meta.method === 'gemini')), rows };
}
async function main() {
  const live = process.argv.includes('--live');
  if (live) { try { process.loadEnvFile('.env'); } catch { /* explicit environment */ } }
  if (live && !process.env.GEMINI_API_KEY) throw new Error('--live requires GEMINI_API_KEY.');
  const limitArg = process.argv.find(arg => arg.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : jdParsingCases.length;
  if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer.');
  const cases = jdParsingCases.slice(0, limit);
  const rules = await evaluate(new JdParsingService({ mode: 'rules' }), cases);
  const gemini = live ? await evaluate(createJdParser({ ...process.env, JD_PARSER_MODE: 'auto' }), cases) : undefined;
  console.log(JSON.stringify({ date: new Date().toISOString(), dataset: 'synthetic-jd-v1', note: 'Small development set; exact normalized extracts, not semantic correctness. Evidence-rejected rate is not a hallucination rate. API-success and end-to-end denominators are separate.', rules, gemini }, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(error => { console.error(error instanceof Error ? error.message : 'JD evaluation failed'); process.exitCode = 1; });
