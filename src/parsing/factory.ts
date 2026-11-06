import { resolve } from 'node:path';
import { GeminiJdExtractor } from './gemini.js';
import { JdParsingService } from './service.js';
export function createJdParser(env: NodeJS.ProcessEnv = process.env, opts: { offline?: boolean } = {}) {
  const mode = env.JD_PARSER_MODE ?? 'auto';
  if (!['auto', 'rules'].includes(mode)) throw new Error('JD_PARSER_MODE must be auto or rules.');
  const timeoutMs = env.JD_PARSER_TIMEOUT_MS === undefined ? 10000 : Number(env.JD_PARSER_TIMEOUT_MS);
  const offline = opts.offline || mode === 'rules';
  return new JdParsingService({ mode: offline ? 'rules' : 'auto', timeoutMs,
    extractor: !offline && env.GEMINI_API_KEY ? new GeminiJdExtractor(env.JD_PARSER_MODEL || 'gemini-3.1-flash-lite', env.GEMINI_API_KEY) : undefined,
    cacheDir: env.JD_PARSER_CACHE_DIR === 'off' ? undefined : resolve(env.JD_PARSER_CACHE_DIR || '.cache/parsing/jd'),
  });
}
