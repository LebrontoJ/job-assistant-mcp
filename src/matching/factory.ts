import { createLLM } from '../agent/llm/index.js';
import { ModeSchema } from './types.js';
import type { MatchingOptions } from './agent.js';
/** Matching has independent model settings; offline hosts never instantiate a provider. */
export function createMatching(env: NodeJS.ProcessEnv = process.env, offline = false): MatchingOptions {
  const mode = offline ? 'retrieval' : ModeSchema.parse(env.MATCH_MODE ?? 'agent');
  if (mode === 'retrieval') return { mode };
  const provider = env.MATCH_PROVIDER || env.LLM_PROVIDER;
  const llm = createLLM({ provider, model: env.MATCH_MODEL || undefined }, env);
  return { mode, llm };
}
