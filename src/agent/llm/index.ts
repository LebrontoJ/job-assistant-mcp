import { AnthropicClient, type AnthropicOptions } from "./anthropic.js";
import { GeminiClient } from "./gemini.js";
import type { LLMClient } from "./types.js";

export type { LLMClient } from "./types.js";

export interface LLMConfig {
  provider?: string;
  model?: string;
}

/** Picks the backend from args/env so swapping models never touches the agent loop. */
export function createLLM(cfg: LLMConfig = {}, env: NodeJS.ProcessEnv = process.env): LLMClient {
  const canon = (p: string) => (p.toLowerCase() === "claude" ? "anthropic" : p.toLowerCase());
  const provider = canon(cfg.provider ?? env.LLM_PROVIDER ?? "gemini");
  // LLM_MODEL belongs to LLM_PROVIDER; never hand one vendor's model id to another (e.g. a Claude judge).
  const envModel = provider === canon(env.LLM_PROVIDER ?? "gemini") ? env.LLM_MODEL : undefined;
  const model = cfg.model || envModel || undefined;
  switch (provider) {
    case "gemini": {
      const key = env.GEMINI_API_KEY;
      if (!key) throw new Error("GEMINI_API_KEY is not set (copy .env.example to .env and fill it in).");
      return new GeminiClient(model ?? "gemini-3.1-flash-lite", key);
    }
    case "anthropic": {
      const chosen = model ?? "claude-opus-5-5";
      const effort = env.LLM_EFFORT as AnthropicOptions["effort"];
      return new AnthropicClient(chosen, {
        // No key check here: the SDK also resolves `ant auth login` profiles and other credential sources.
        apiKey: env.ANTHROPIC_API_KEY || undefined,
        effort: effort || undefined,
        // Refusal fallback is on by default for the current models; LLM_FALLBACK=off for non-Claude-API hosts.
        fallback: env.LLM_FALLBACK !== "off",
      });
    }
    default:
      throw new Error(`Unknown LLM provider "${provider}". Supported: gemini, anthropic.`);
  }
}
