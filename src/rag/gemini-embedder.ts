import { GoogleGenAI } from "@google/genai";
import { withRetry } from "../agent/llm/retry.js";
import type { EmbedKind, Embedder } from "./embedder.js";

/** The slice of the SDK used here, so tests can inject a fake. */
export interface EmbedApi {
  models: { embedContent(params: Record<string, unknown>): Promise<{ embeddings?: Array<{ values?: number[] }> }> };
}

export interface GeminiEmbedderOptions {
  apiKey: string;
  model?: string;
  /** Output size. 768 is a recommended size; cosine similarity does not need the vectors normalised. */
  dimensions?: number;
  batchSize?: number;
  client?: EmbedApi;
}

export const DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001";

/**
 * gemini-embedding-2 has no task_type and folds several plain inputs into ONE vector, so each input is
 * wrapped in its own Content and the task goes in a text prefix. gemini-embedding-001 takes a task type
 * and returns one vector per string.
 */
export class GeminiEmbedder implements Embedder {
  readonly id: string;
  private readonly api: EmbedApi;
  private readonly model: string;
  private readonly dimensions: number;
  private readonly batchSize: number;

  constructor(opts: GeminiEmbedderOptions) {
    this.model = opts.model ?? DEFAULT_EMBEDDING_MODEL;
    this.dimensions = opts.dimensions ?? 768;
    this.batchSize = opts.batchSize ?? 50;
    this.id = `gemini-${this.model}-${this.dimensions}`;
    this.api = opts.client ?? (new GoogleGenAI({ apiKey: opts.apiKey }) as unknown as EmbedApi);
  }

  async embed(texts: string[], kind: EmbedKind = "document"): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      out.push(...(await this.embedBatch(texts.slice(i, i + this.batchSize), kind)));
    }
    return out;
  }

  private async embedBatch(batch: string[], kind: EmbedKind): Promise<number[][]> {
    const v2 = this.model.startsWith("gemini-embedding-2");
    const params: Record<string, unknown> = v2
      ? {
          model: this.model,
          contents: batch.map((t) => ({
            parts: [{ text: kind === "query" ? `task: search result | query: ${t}` : `title: none | text: ${t}` }],
          })),
          config: { outputDimensionality: this.dimensions },
        }
      : {
          model: this.model,
          contents: batch,
          config: {
            taskType: kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
            outputDimensionality: this.dimensions,
          },
        };
    const res = await withRetry(() => this.api.models.embedContent(params));
    const vectors = (res.embeddings ?? []).map((e) => e.values ?? []);
    // A merged or short response would silently misalign vectors with chunks; fail loudly instead.
    if (vectors.length !== batch.length || vectors.some((v) => v.length === 0)) {
      throw new Error(`Embedding API returned ${vectors.length} vector(s) for ${batch.length} input(s) (model ${this.model})`);
    }
    return vectors;
  }
}
