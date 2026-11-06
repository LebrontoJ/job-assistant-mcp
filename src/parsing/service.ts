import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { parseJd } from '../server/jd.js';
import { JD_PARSER_VERSION, ParseFailure, validateExtraction } from './jd.js';
import type { CachedExtraction, FallbackReason, JdExtractor, JdParser, JdParseResult } from './types.js';
interface Job { controller: AbortController; promise: Promise<JdParseResult>; subscribers: number; usageClaimed: boolean }
export interface JdParserOptions {
  extractor?: JdExtractor; mode?: 'auto' | 'rules'; timeoutMs?: number; cacheDir?: string;
  fallbackTtlMs?: number; maxEntries?: number;
}
const cancelled = () => new DOMException('JD parsing cancelled', 'AbortError');
function reason(error: unknown): FallbackReason {
  if (error instanceof ParseFailure) return error.reason;
  const e = error as { status?: number; code?: number };
  return (e?.status ?? e?.code) === 429 ? 'rate_limited' : 'provider_error';
}
export class JdParsingService implements JdParser {
  private readonly memory = new Map<string, { result: JdParseResult; expires: number }>();
  private readonly pending = new Map<string, Job>();
  constructor(private readonly opts: JdParserOptions = {}) {
    const timeout = opts.timeoutMs ?? 10000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 12000) throw new Error('JD parser timeout must be 1..12000ms (below the 15s tool budget).');
  }
  async parse(text: string, signal?: AbortSignal): Promise<JdParseResult> {
    signal?.throwIfAborted();
    if (text.trim().length < 20 || text.length > 50000) throw new Error('JD text must contain 20..50000 characters.');
    const start = Date.now();
    if (this.opts.mode === 'rules' || !this.opts.extractor) return this.rules(text, start, this.opts.mode === 'rules' ? undefined : 'missing_key');
    const key = createHash('sha256').update(JSON.stringify({ text, provider: 'gemini', model: this.opts.extractor.model, version: JD_PARSER_VERSION })).digest('hex');
    const cached = this.memory.get(key);
    if (cached && cached.expires > Date.now()) return this.replay(cached.result, start);
    this.memory.delete(key);
    let job = this.pending.get(key);
    if (!job) {
      const controller = new AbortController();
      job = { controller, subscribers: 0, usageClaimed: false, promise: this.run(text, key, controller.signal) };
      this.pending.set(key, job);
      const current = job;
      void job.promise.finally(() => { if (this.pending.get(key) === current) this.pending.delete(key); }).catch(() => {});
    }
    const current = job;
    current.subscribers++;
    try {
      const result = await new Promise<JdParseResult>((resolve, reject) => {
        const abort = () => reject(signal?.reason ?? cancelled());
        signal?.addEventListener('abort', abort, { once: true });
        current.promise.then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
        if (signal?.aborted) abort();
      });
      // Assign accounting to the first surviving subscriber, rather than the job creator.
      // The creator may have cancelled while another caller still needs the shared result.
      if (current.usageClaimed) return this.replay(result, start);
      current.usageClaimed = true;
      return structuredClone(result);
    } finally {
      if (--current.subscribers === 0 && this.pending.get(key) === current) {
        this.pending.delete(key); current.controller.abort(cancelled());
      }
    }
  }
  private replay(result: JdParseResult, start: number): JdParseResult {
    const out = structuredClone(result);
    return { data: out.data, meta: { ...out.meta, cacheHit: true, ms: Date.now() - start, apiCalls: 0, inputTokens: 0, outputTokens: 0 } };
  }
  private rules(text: string, start: number, fallbackReason?: FallbackReason, apiCalls = 0): JdParseResult {
    return { data: parseJd(text), meta: { method: 'rules', model: apiCalls ? this.opts.extractor?.model : undefined,
      version: JD_PARSER_VERSION, cacheHit: false, ms: Date.now() - start, apiCalls, inputTokens: 0, outputTokens: 0,
      fallbackReason, warnings: fallbackReason ? [`Gemini unavailable (${fallbackReason}); using rule-based JD parsing.`] : [] } };
  }
  private async run(text: string, key: string, parent: AbortSignal): Promise<JdParseResult> {
    const start = Date.now();
    const controller = new AbortController();
    const abort = () => controller.abort(parent.reason);
    parent.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException('JD parsing timed out', 'TimeoutError')), this.opts.timeoutMs ?? 10000);
    let apiCalls = 0, inputTokens = 0, outputTokens = 0;
    let cached: CachedExtraction | undefined;
    const work = async (): Promise<JdParseResult> => {
      if (this.opts.cacheDir) {
        try {
          const entry = JSON.parse(await readFile(join(this.opts.cacheDir, `${key}.json`), { encoding: 'utf8', signal: controller.signal })) as CachedExtraction;
          cached = { ...entry, extraction: validateExtraction(entry.extraction, text) };
        } catch { /* Cache corruption or unavailable storage is a miss. */ }
      }
      controller.signal.throwIfAborted();
      let extraction = cached?.extraction;
      if (!extraction) {
        apiCalls++;
        const response = await this.opts.extractor!.extract(text, controller.signal);
        controller.signal.throwIfAborted();
        inputTokens = response.inputTokens; outputTokens = response.outputTokens;
        extraction = validateExtraction(response.value, text);
      }
      const result: JdParseResult = { data: extraction.data, meta: { method: 'gemini', model: this.opts.extractor!.model,
        version: JD_PARSER_VERSION, cacheHit: !!cached, ms: Date.now() - start, apiCalls, inputTokens, outputTokens, warnings: [] } };
      if (!cached && this.opts.cacheDir) {
        // Storage failure must never discard a valid extraction. Atomic files contain only validated data.
        const file = join(this.opts.cacheDir, `${key}.json`), tmp = `${file}.${randomUUID()}.tmp`;
        try {
          await mkdir(this.opts.cacheDir, { recursive: true });
          controller.signal.throwIfAborted();
          await writeFile(tmp, JSON.stringify({ extraction, inputTokens, outputTokens }), { mode: 0o600, signal: controller.signal });
          controller.signal.throwIfAborted();
          await rename(tmp, file);
        } catch { /* optional cache */ } finally { await unlink(tmp).catch(() => {}); }
      }
      return result;
    };
    try {
      const interrupted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
        if (controller.signal.aborted) reject(controller.signal.reason);
      });
      let result: JdParseResult;
      try { result = await Promise.race([work(), interrupted]); }
      catch (error) {
        if (parent.aborted) throw parent.reason;
        result = this.rules(text, start, controller.signal.aborted ? 'timeout' : reason(error), apiCalls);
        result.meta.inputTokens = error instanceof ParseFailure && error.usage ? error.usage.inputTokens : inputTokens;
        result.meta.outputTokens = error instanceof ParseFailure && error.usage ? error.usage.outputTokens : outputTokens;
      }
      if (parent.aborted) throw parent.reason;
      // Bounded in-memory cache. Briefly share a fallback so the two tools use the same result.
      this.memory.set(key, { result, expires: result.meta.method === 'gemini' ? Infinity : Date.now() + (this.opts.fallbackTtlMs ?? 30000) });
      while (this.memory.size > (this.opts.maxEntries ?? 128)) this.memory.delete(this.memory.keys().next().value!);
      return structuredClone(result);
    } finally { clearTimeout(timer); parent.removeEventListener('abort', abort); }
  }
}
