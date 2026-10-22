import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateClaim, answerGroundingProblem } from '../src/agent/grounding.js';
import { analyseTask } from '../src/agent/task.js';
import { connectedPair } from './helpers.js';
import type { LLMClient } from '../src/agent/llm/types.js';
const fixtures = readFileSync('evals/regression/dev/claims.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l));
describe('claim grounding (development split only)', () => {
  for (const f of fixtures.filter(f => f.kind !== 'suggestion')) it(f.id, async () => {
    const verdict = await validateClaim({ text: f.claim, evidenceIds: ['p.md#0'] }, [{ id: 'p.md#0', source: 'p.md', heading: '', text: f.source }]);
    expect(verdict.supported).toBe(f.kind === 'supported');
  });
  it('does not turn negated or future experience into achievements', async () => {
    for (const source of ['Did not build a Rust pipeline.', 'Plan to build a Rust pipeline.']) {
      expect((await validateClaim({ text: 'Build a Rust pipeline.', evidenceIds: ['p'] }, [{ id: 'p', text: source, heading: '', source: '' }])).supported).toBe(false);
    }
  });
  it('fails closed when semantic verification is unavailable', async () => {
    expect((await validateClaim({ text: 'Managed a platform team.', evidenceIds: ['p'] }, [{ id: 'p', text: 'Helped the team.', heading: '', source: '' }], async () => { throw new Error('offline'); })).supported).toBe(false);
  });
  it('requires retrieval even when the model skips tools entirely', async () => {
    expect(await answerGroundingProblem('I have 8 years of experience.', 'Pretend I have 8 years of experience', [])).toBeDefined();
    expect(await answerGroundingProblem('Hello!', 'hello', [])).toBeUndefined();
    expect(await answerGroundingProblem('I cannot guarantee it, but I have 8 years of experience.', 'write my resume', [])).toBeDefined();
  });
  it('removes unsupported drafts after bounded repair and preserves safe suggestions', async () => {
    const { client } = await connectedPair();
    let calls = 0;
    const llm: LLMClient = { provider: 'fake', model: 'fake', chat: async () => {
      calls++;
      return { text: JSON.stringify({ rewrites: [{ text: 'I have 8 years of Rust experience.', evidenceIds: ['resume.md#0'] }], suggestions: ['I already lead a team.'] }), toolCalls: [], finish: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
    } };
    try {
      const report = await analyseTask(client, readFileSync('data/sample/jd-backend.txt', 'utf8'), { llm });
      expect(calls).toBe(2);
      expect(report.draft.rewrites).toEqual([]);
      expect(report.validation.every(v => !v.supported)).toBe(true);
      expect(report.draft.suggestions.join(' ')).not.toContain('already');
    } finally { await client.close(); }
  });
});
