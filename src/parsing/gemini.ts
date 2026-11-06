import { GoogleGenAI, type GenerateContentParameters, type GenerateContentResponse } from '@google/genai';
import { z } from 'zod';
import { ExtractionSchema, JD_SYSTEM, ParseFailure } from './jd.js';
import type { JdExtractor } from './types.js';
export interface ExtractionApi { models: { generateContent(req: GenerateContentParameters): Promise<GenerateContentResponse> } }
export class GeminiJdExtractor implements JdExtractor {
  private readonly client: ExtractionApi;
  constructor(readonly model: string, apiKey: string, client?: ExtractionApi) {
    // No SDK retries: the parser owns the complete budget and fallback policy.
    this.client = client ?? new GoogleGenAI({ apiKey, httpOptions: { retryOptions: { attempts: 1 } } });
  }
  async extract(text: string, signal: AbortSignal) {
    const response = await this.client.models.generateContent({
      model: this.model, contents: [{ role: 'user', parts: [{ text }] }],
      config: { systemInstruction: JD_SYSTEM, responseMimeType: 'application/json',
        responseJsonSchema: z.toJSONSchema(ExtractionSchema), abortSignal: signal, maxOutputTokens: 8192 },
    });
    const usage = { inputTokens: response.usageMetadata?.promptTokenCount ?? 0, outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0 };
    const candidate = response.candidates?.[0];
    if (!candidate || ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'RECITATION'].includes(candidate.finishReason ?? '')) throw new ParseFailure('blocked', usage);
    if (candidate.finishReason === 'MAX_TOKENS') throw new ParseFailure('truncated', usage);
    if (candidate.finishReason !== 'STOP') throw new ParseFailure('invalid_output', usage);
    const raw = (candidate.content?.parts ?? []).filter(p => p.text && !p.thought).map(p => p.text).join('');
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new ParseFailure('invalid_output', usage); }
    return { value, ...usage };
  }
}
