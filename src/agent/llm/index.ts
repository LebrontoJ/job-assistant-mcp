import { GeminiClient } from "./gemini.js";
import type { LLMClient } from "./types.js";

export type { LLMClient } from "./types.js";

export interface LLMConfig {
  provider?: string;
  model?: string;
}

/** Picks the backend from args/env so swapping models never touches the agent loop. */
export function createLLM(cfg: LLMConfig = {}, env: NodeJS.ProcessEnv = process.env): LLMClient {
  const provider = (cfg.provider ?? env.LLM_PROVIDER ?? "gemini").toLowerCase();
  const model = cfg.model ?? env.LLM_MODEL;
  switch (provider) {
    case "gemini": {
      const key = env.GEMINI_API_KEY;
      if (!key) throw new Error("GEMINI_API_KEY is not set (copy .env.example to .env and fill it in).");
      return new GeminiClient(model ?? "gemini-3.1-flash-lite", key);
    }
    default:
      throw new Error(`Unknown LLM provider "${provider}". Supported: gemini.`);
  }
}
