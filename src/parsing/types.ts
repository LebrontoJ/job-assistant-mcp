import type { ParsedJd } from '../server/jd.js';
import type { JdExtraction } from './jd.js';
export type FallbackReason = 'missing_key' | 'timeout' | 'rate_limited' | 'provider_error' | 'blocked' | 'truncated' | 'invalid_output' | 'unsupported_evidence';
export interface ParseMeta {
  method: 'gemini' | 'rules'; model?: string; version: string; cacheHit: boolean;
  ms: number; apiCalls: number; inputTokens: number; outputTokens: number;
  fallbackReason?: FallbackReason; warnings: string[];
}
export interface JdParseResult { data: ParsedJd; meta: ParseMeta }
export interface ExtractionResponse { value: unknown; inputTokens: number; outputTokens: number }
export interface JdExtractor { readonly model: string; extract(text: string, signal: AbortSignal): Promise<ExtractionResponse> }
export interface JdParser { parse(text: string, signal?: AbortSignal): Promise<JdParseResult> }
export interface CachedExtraction { extraction: JdExtraction; inputTokens: number; outputTokens: number }
