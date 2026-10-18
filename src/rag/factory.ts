import { CachingEmbedder } from "./embed-cache.js";
import type { Embedder } from "./embedder.js";
import { GeminiEmbedder } from "./gemini-embedder.js";

/**
 * Conservative floor for gemini-embedding-001 at 768 dims: on 22 queries, unrelated ones peaked at 0.62 and relevant
 * ones bottomed out at 0.59, so no threshold separates them. 0.55 only removes the clearly unrelated (about 6 in 10
 * unrelated queries, none of the relevant ones). It is not a decision boundary. Re-measure for any other model.
 */
export const DEFAULT_MIN_SIMILARITY = 0.55;

export interface EmbeddingConfig {
  embedder?: Embedder;
  /** Passed to ProfileIndex so hybrid search does not return unrelated chunks. */
  minSimilarity?: number;
}

/**
 * Chooses the dense-retrieval backend from EMBEDDINGS ("none" | "gemini" | "local"). Unset or "none" keeps
 * retrieval lexical-only: no network, no key. Vectors are cached in .cache/embeddings.
 */
export function createEmbedding(env: NodeJS.ProcessEnv = process.env): EmbeddingConfig {
  const kind = (env.EMBEDDINGS ?? "none").toLowerCase();
  switch (kind) {
    case "":
    case "none":
      return {};
    case "gemini": {
      const apiKey = env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("EMBEDDINGS=gemini needs GEMINI_API_KEY.");
      const inner = new GeminiEmbedder({
        apiKey,
        model: env.EMBEDDING_MODEL || undefined,
        dimensions: env.EMBEDDING_DIMENSIONS ? Number(env.EMBEDDING_DIMENSIONS) : undefined,
      });
      const usesDefaultModel = !env.EMBEDDING_MODEL && !env.EMBEDDING_DIMENSIONS;
      return {
        embedder: new CachingEmbedder(inner, ".cache/embeddings"),
        // The default floor was measured for the default model only; other models get none until measured.
        minSimilarity: env.EMBEDDING_MIN_SIM
          ? Number(env.EMBEDDING_MIN_SIM)
          : usesDefaultModel
            ? DEFAULT_MIN_SIMILARITY
            : undefined,
      };
    }
    case "local":
      throw new Error(
        "EMBEDDINGS=local is not implemented yet: the local embedding model adapter has not been added. " +
          "Use EMBEDDINGS=none (BM25 only) or EMBEDDINGS=gemini.",
      );
    default:
      throw new Error(`Unknown EMBEDDINGS value "${kind}". Supported: none, gemini, local.`);
  }
}
