import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { JdParsingService } from '../src/parsing/service.js';
import { createJdParser } from '../src/parsing/factory.js';
import { GeminiJdExtractor, type ExtractionApi } from '../src/parsing/gemini.js';
import { validateExtraction } from '../src/parsing/jd.js';
import { parseJd } from '../src/server/jd.js';
import { createServer } from '../src/server/server.js';
import { ApplicationStore } from '../src/store/applications.js';
import { ProfileIndex } from '../src/rag/index.js';
import { analyseTask } from '../src/agent/task.js';
import { MemoryTracer, formatTrace, summarizeEvents } from '../src/agent/trace.js';
import type { JdExtraction } from '../src/parsing/jd.js';
import type { JdExtractor } from '../src/parsing/types.js';

const source = '平台工程师\n公司：示例科技\n地点：上海\n远程办公。需要3年以上工作经验，熟悉 TypeScript 和 Bun。优先考虑使用过 Hono 的候选人。负责维护平台。';
const extraction: JdExtraction = {
  data: { title: '平台工程师', company: '示例科技', location: '上海', workMode: 'remote', minYearsExperience: 3,
    responsibilities: ['负责维护平台'], requirements: ['需要3年以上工作经验', '熟悉 TypeScript 和 Bun'],
    niceToHave: ['优先考虑使用过 Hono 的候选人'], skills: ['TypeScript', 'Bun', 'Hono'] },
  workModeEvidence: '远程办公', yearsEvidence: '需要3年以上工作经验',
};
const good = () => ({ value: structuredClone(extraction), inputTokens: 100, outputTokens: 50 });
function fake(fn: JdExtractor['extract'] = async () => good()) {
  return { model: 'fixture', extract: vi.fn(fn) };
}

describe('JD extraction validation', () => {
  it('accepts grounded Chinese prose and skills outside the old dictionary', () => {
    expect(validateExtraction(extraction, source).data).toEqual(extraction.data);
    expect(parseJd(source).requirements).toEqual([]);
  });
  it.each([
    (e: JdExtraction) => { e.data.skills.push('Rust'); },
    (e: JdExtraction) => { e.data.company = 'InventedCo'; },
    (e: JdExtraction) => { e.data.minYearsExperience = 8; },
    (e: JdExtraction) => { e.data.workMode = 'hybrid'; },
    (e: JdExtraction) => { e.yearsEvidence = null; },
  ])('rejects invented or inconsistent evidence', mutate => {
    const e = structuredClone(extraction); mutate(e);
    expect(() => validateExtraction(e, source)).toThrow('unsupported_evidence');
  });
  it('rejects partial skill words and omission of known requirement sections', () => {
    const e = structuredClone(extraction);
    e.data.skills = ['Go'];
    expect(() => validateExtraction(e, source + ' Google')).toThrow('unsupported_evidence');
    const missing = { data: { ...extraction.data, requirements: [], niceToHave: [] }, workModeEvidence: extraction.workModeEvidence, yearsEvidence: extraction.yearsEvidence };
    expect(() => validateExtraction(missing, source + '\nRequirements:\n- Know TypeScript')).toThrow('unsupported_evidence');
  });
  it('allows an ordinary company description with no independent requirements', async () => {
    const e = { data: { title: null, company: null, location: null, workMode: null, minYearsExperience: null,
      responsibilities: [], requirements: [], niceToHave: [], skills: [] }, workModeEvidence: null, yearsEvidence: null };
    const result = await new JdParsingService({ extractor: fake(async () => ({ ...good(), value: e })) }).parse('We are a company making software for our customers.');
    expect(result.meta.method).toBe('gemini');
  });
});

describe('Gemini structured extraction adapter', () => {
  function sdk(finishReason = 'STOP', text = JSON.stringify(extraction)) {
    const generateContent = vi.fn(async () => ({ candidates: [{ finishReason, content: { parts: [{ text: 'hidden reasoning', thought: true }, { text }] } }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 6 } }));
    return { models: { generateContent } } as unknown as ExtractionApi;
  }
  it('sends only JD text, schema and system instruction with cancellation', async () => {
    const api = sdk(), signal = new AbortController().signal;
    const result = await new GeminiJdExtractor('fixture', 'unused', api).extract(source, signal);
    expect(result.value).toEqual(extraction);
    expect(api.models.generateContent).toHaveBeenCalledWith(expect.objectContaining({ contents: [{ role: 'user', parts: [{ text: source }] }], config: expect.objectContaining({ responseMimeType: 'application/json', responseJsonSchema: expect.any(Object), abortSignal: signal }) }));
    expect(result.inputTokens).toBe(12);
  });
  it.each([['SAFETY', 'blocked'], ['MAX_TOKENS', 'truncated'], ['OTHER', 'invalid_output'], ['STOP', 'invalid_output']])('rejects incomplete or malformed output: %s', async (finish, reason) => {
    await expect(new GeminiJdExtractor('fixture', 'unused', sdk(finish, 'bad json')).extract(source, new AbortController().signal)).rejects.toThrow(reason);
  });
});

describe('JD parsing service', () => {
  it('uses rules offline or without a key', async () => {
    const extractor = fake();
    expect((await new JdParsingService({ mode: 'rules', extractor }).parse(source)).data).toEqual(parseJd(source));
    expect(extractor.extract).not.toHaveBeenCalled();
    expect((await createJdParser({}).parse(source)).meta.fallbackReason).toBe('missing_key');
    expect((await createJdParser({ GEMINI_API_KEY: 'unused' }, { offline: true }).parse(source)).meta.fallbackReason).toBeUndefined();
  });
  it('validates configuration and bounds input before any API call', async () => {
    expect(() => createJdParser({ JD_PARSER_MODE: 'unknown' })).toThrow('JD_PARSER_MODE');
    expect(() => createJdParser({ JD_PARSER_TIMEOUT_MS: '15000' })).toThrow('timeout');
    const extractor = fake(), parser = new JdParsingService({ extractor });
    await expect(parser.parse('short')).rejects.toThrow('20..50000');
    await expect(parser.parse('a'.repeat(50001))).rejects.toThrow('20..50000');
    expect(extractor.extract).not.toHaveBeenCalled();
  });
  it.each([[429, 'rate_limited'], [503, 'provider_error'], [401, 'provider_error']])('falls back without retry for status %s', async (status, fallbackReason) => {
    const extractor = fake(async () => { throw { status, message: 'sensitive SDK body' }; });
    const result = await new JdParsingService({ extractor }).parse(source);
    expect(result.data).toEqual(parseJd(source));
    expect(result.meta).toMatchObject({ method: 'rules', fallbackReason, apiCalls: 1 });
    expect(JSON.stringify(result)).not.toContain('sensitive');
    expect(extractor.extract).toHaveBeenCalledTimes(1);
  });
  it('falls back for schema and evidence failures', async () => {
    for (const value of [{}, { ...extraction, data: { ...extraction.data, skills: ['Rust'] } }]) {
      const result = await new JdParsingService({ extractor: fake(async () => ({ ...good(), value })) }).parse(source);
      expect(result.meta).toMatchObject({ method: 'rules', inputTokens: 100, outputTokens: 50 });
    }
  });
  it('aborts a hanging SDK and returns rules within the parser budget', async () => {
    let aborted = false;
    const extractor = fake(async (_, signal) => { signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); });
    const result = await new JdParsingService({ extractor, timeoutMs: 20 }).parse(source);
    expect(result.meta.fallbackReason).toBe('timeout');
    expect(aborted).toBe(true);
  });
  it('shares concurrent calls and isolates caller cancellation', async () => {
    let finish!: () => void;
    const extractor = fake(async () => { await new Promise<void>(r => { finish = r; }); return good(); });
    const parser = new JdParsingService({ extractor });
    const controller = new AbortController();
    const first = parser.parse(source, controller.signal);
    const second = parser.parse(source);
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect((extractor.extract.mock.calls[0]![1] as AbortSignal).aborted).toBe(false);
    finish();
    expect((await second).meta).toMatchObject({ method: 'gemini', apiCalls: 1, inputTokens: 100, outputTokens: 50 });
    expect(extractor.extract).toHaveBeenCalledTimes(1);
    const third = await parser.parse(source);
    expect(third.meta).toMatchObject({ cacheHit: true, apiCalls: 0, inputTokens: 0 });
    third.data.skills.push('mutation');
    expect((await parser.parse(source)).data.skills).not.toContain('mutation');
  });
  it('aborts shared work when all subscribers cancel and permits a fresh attempt', async () => {
    let signal!: AbortSignal;
    const extractor = fake(async (_, s) => { signal = s; return new Promise(() => {}); });
    const parser = new JdParsingService({ extractor });
    const controller = new AbortController();
    const result = parser.parse(source, controller.signal); controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(signal.aborted).toBe(true);
    extractor.extract.mockImplementation(async () => good());
    expect((await parser.parse(source)).meta.method).toBe('gemini');
  });
  it('does not start an API call for an already cancelled request', async () => {
    const controller = new AbortController(); controller.abort();
    const extractor = fake();
    await expect(new JdParsingService({ extractor }).parse(source, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(extractor.extract).not.toHaveBeenCalled();
  });
  it('shares fallbacks briefly and recovers after expiry', async () => {
    const extractor = fake(async () => { throw { status: 429 }; });
    const parser = new JdParsingService({ extractor, fallbackTtlMs: 15 });
    expect((await parser.parse(source)).meta.method).toBe('rules');
    expect((await parser.parse(source)).meta.cacheHit).toBe(true);
    extractor.extract.mockImplementation(async () => good());
    await new Promise(r => setTimeout(r, 20));
    expect((await parser.parse(source)).meta.method).toBe('gemini');
    expect(extractor.extract).toHaveBeenCalledTimes(2);
  });
  it('retains known SDK usage on invalid JSON output', async () => {
    const api = { models: { generateContent: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'bad json' }] } }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 6 } }) } } as unknown as ExtractionApi;
    const result = await new JdParsingService({ extractor: new GeminiJdExtractor('fixture', 'unused', api) }).parse(source);
    expect(result.meta).toMatchObject({ method: 'rules', fallbackReason: 'invalid_output', inputTokens: 12, outputTokens: 6 });
  });
  it('returns valid extraction when disk caching is unavailable and bounds memory entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jd-storage-'));
    const file = join(dir, 'not-a-directory'); await writeFile(file, '');
    const extractor = fake(), parser = new JdParsingService({ extractor, cacheDir: file, maxEntries: 1 });
    expect((await parser.parse(source)).meta.method).toBe('gemini');
    await parser.parse(source + '\nExtra text.');
    await parser.parse(source);
    expect(extractor.extract).toHaveBeenCalledTimes(3);
  });
  it('persists validated results, invalidates model/content keys and tolerates corrupt storage', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'jd-cache-'));
    const extractor = fake();
    await new JdParsingService({ extractor, cacheDir }).parse(source);
    expect((await new JdParsingService({ extractor, cacheDir }).parse(source)).meta).toMatchObject({ cacheHit: true, apiCalls: 0 });
    expect(extractor.extract).toHaveBeenCalledTimes(1);
    await new JdParsingService({ extractor: { ...extractor, model: 'other' }, cacheDir }).parse(source);
    await new JdParsingService({ extractor, cacheDir }).parse(source + '\nExtra text.');
    expect(extractor.extract).toHaveBeenCalledTimes(3);
    for (const file of await readdir(cacheDir)) await writeFile(join(cacheDir, file), '{}');
    expect((await new JdParsingService({ extractor, cacheDir }).parse(source)).meta.cacheHit).toBe(false);
    expect(extractor.extract).toHaveBeenCalledTimes(4);
  });
});

it('runs a full MCP task with one extraction, unchanged source chunks and correlated parsing traces', async () => {
  const extractor = fake(), tracer = new MemoryTracer();
  const profile = ProfileIndex.fromMarkdown({ 'resume.md': '# Experience\nMaintained a TypeScript platform using Bun and Hono.' });
  const before = structuredClone(profile.chunks);
  const dir = await mkdtemp(join(tmpdir(), 'jd-mcp-'));
  const server = createServer(new ApplicationStore(join(dir, 'apps.json')), profile, { jdParser: new JdParsingService({ extractor }), tracer });
  const client = new Client({ name: 'fixture', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const report = await analyseTask(client, source);
    expect(report.jd).toEqual(extraction.data);
    expect(report.parsing?.method).toBe('gemini');
    expect(report.requirements.map(r => r.item)).toEqual([...extraction.data.requirements, ...extraction.data.niceToHave]);
    expect(extractor.extract).toHaveBeenCalledTimes(1);
    expect(profile.chunks).toEqual(before);
    const events = tracer.events.filter((e): e is Extract<typeof e, { type: 'jd_parse' }> => e.type === 'jd_parse');
    expect(events).toHaveLength(2);
    expect(events.every(e => e.taskId === report.taskId && !!e.toolCallId)).toBe(true);
    expect(events.reduce((n, e) => n + e.apiCalls, 0)).toBe(1);
    expect(summarizeEvents(events).parsing).toMatchObject({ calls: 2, apiCalls: 1, cacheHits: 1, inputTokens: 100 });
    expect(formatTrace(events)).toContain('JD     gemini/fixture');
  } finally { await client.close(); await server.close(); }
});
