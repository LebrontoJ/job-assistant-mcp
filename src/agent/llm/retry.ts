export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  isRetryable?: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

/** Free API tiers rate-limit aggressively, so 429/5xx are retried with exponential backoff + jitter. */
export function isTransient(err: unknown): boolean {
  const status = (err as { status?: number; code?: number } | null)?.status ??
    (err as { code?: number } | null)?.code;
  if (typeof status === "number") return status === 429 || status >= 500;
  return /ECONNRESET|ETIMEDOUT|fetch failed|RESOURCE_EXHAUSTED|UNAVAILABLE/i.test(String(err));
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { retries = 4, baseDelayMs = 1000, isRetryable = isTransient } = opts;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      await sleep(baseDelayMs * 2 ** attempt * (0.75 + Math.random() * 0.5));
    }
  }
}
