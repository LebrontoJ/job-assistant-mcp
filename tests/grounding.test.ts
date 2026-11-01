import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateClaim, answerGroundingProblem } from '../src/agent/grounding.js';
import { analyseTask } from '../src/agent/task.js';
import { connectedPair } from './helpers.js';
import type { LLMClient } from '../src/agent/llm/types.js';
const fixtures = readFileSync('evals/regression/dev/claims.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l));
describe('claim grounding (development split only)', () => {
  it('retains unimplemented and planned context when extracting a later clause', async () => {
    for (const text of [
      '以下方案尚未实施：并行调用；将平均延迟从4s降至2.5s。',
      '以下方案尚未实施。将平均延迟从4s降至2.5s。',
      '计划：并行调用；将平均延迟从4s降至2.5s。',
    ]) {
      const evidence = [{ id: 'cn.md#0', source: 'cn.md', heading: '', text }];
      const claim = { text: '将平均延迟从4s降至2.5s。', evidenceIds: ['cn.md#0'] };
      expect((await validateClaim(claim, evidence)).supported).toBe(false);
      const verify = vi.fn(async () => false);
      expect((await validateClaim(claim, evidence, verify)).supported).toBe(false);
      expect(verify).toHaveBeenCalledWith(claim, evidence);
    }
  });
  it('accepts adjacent Chinese factual sentences without borrowing or reversing quantities', async () => {
    const evidence = [{ id: 'cn.md#0', source: 'cn.md', heading: '', text: '通过日志定位瓶颈。平均延迟从4s降至2.5s。查询次数从4次降至1次。' }];
    const claim = (text: string) => ({ text, evidenceIds: ['cn.md#0'] });
    expect((await validateClaim(claim('平均延迟从4s降至2.5s。查询次数从4次降至1次。'), evidence)).supported).toBe(true);
    for (const text of [
      '平均延迟从4s降至1s。查询次数从4次降至1次。',
      '平均延迟从2.5s降至4s。查询次数从4次降至1次。',
    ]) {
      const verify = vi.fn(async () => true);
      expect((await validateClaim(claim(text), evidence, verify)).supported).toBe(false);
      expect(verify).not.toHaveBeenCalled();
    }
  });
  it('checks numeric anchors per claim sentence before verifying a combined paraphrase', async () => {
    const evidence = [{ id: 'p', source: 'p.md', heading: '', text: 'Measured the baseline. Reduced average latency from 8s to 6s. Reduced queries from 4 to 1.' }];
    const verify = vi.fn(async () => true);
    const result = await validateClaim({ text: 'Cut average latency from 8s to 6s. Cut queries from 4 to 1.', evidenceIds: ['p'] }, evidence, verify);
    expect(result).toMatchObject({ supported: true, reason: 'semantic_verification' });
    expect(verify).toHaveBeenCalledOnce();
  });
  it('extracts Chinese sentences without whitespace and keeps quantities anchored to their own sentence', async () => {
    const sources = [{ id: 'cn.md#0', source: 'cn.md', heading: 'Metrics', text: '共实现12个接口。平均延迟从4s降至2.5s。使用集成测试验证结果。' }];
    for (const text of ['共实现12个接口。', '平均延迟从4s降至2.5s。', '使用集成测试验证结果。']) {
      expect((await validateClaim({ text, evidenceIds: ['cn.md#0'] }, sources)).supported).toBe(true);
    }
    expect((await validateClaim({ text: '平均延迟降至12s。', evidenceIds: ['cn.md#0'] }, sources)).supported).toBe(false);
    expect((await validateClaim({ text: '平均延迟从2.5s降至4s。', evidenceIds: ['cn.md#0'] }, sources)).supported).toBe(false);
  });
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
