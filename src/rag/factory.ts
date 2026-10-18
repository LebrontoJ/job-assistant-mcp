import type { Embedder } from "./embedder.js";

/**
 * Chooses the dense-retrieval backend from EMBEDDINGS ("none" | "local"). Unset or "none" keeps the
 * retriever lexical-only, which needs no model download and no network.
 */
export function createEmbedder(kind: string | undefined = process.env.EMBEDDINGS): Embedder | undefined {
  switch ((kind ?? "none").toLowerCase()) {
    case "":
    case "none":
      return undefined;
    case "local":
      throw new Error(
        "EMBEDDINGS=local is not implemented yet: the local embedding model adapter has not been added. " +
          "Unset EMBEDDINGS to use BM25-only retrieval.",
      );
    default:
      throw new Error(`Unknown EMBEDDINGS value "${kind}". Supported: none, local.`);
  }
}
