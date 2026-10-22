export interface RetryOptions {
  signal?: AbortSignal;
  retries?: number;
  baseDelayMs?: number;
  /** Upper bound for a server-requested wait, so a bad hint cannot stall a run forever. */
  maxRetryAfterMs?: number;
  isRetryable?: (err: unknown) => boolean;
  /** Called before each retry sleep, so callers can count retries and the time spent waiting. */
  onRetry?: (info: { attempt: number; waitMs: number; error: unknown }) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** Free API tiers rate-limit aggressively, so 429/5xx are retried with exponential backoff + jitter. */
export function isTransient(err: unknown): boolean {
  const status = (err as { status?: number; code?: number } | null)?.status ??
    (err as { code?: number } | null)?.code;
  if (typeof status === "number") return status === 429 || status >= 500;
  return /ECONNRESET|ETIMEDOUT|fetch failed|RESOURCE_EXHAUSTED|UNAVAILABLE/i.test(String(err));
}

/**
 * How long the server asked us to wait: a `retry-after` header (seconds) or the "retry in 38.09s" /
 * `retryDelay: "38s"` hint Gemini puts in its 429 body. Undefined when there is none.
 */
export function retryAfterMs(err: unknown): number | undefined {
  const e = err as { headers?: { get?: (k: string) => string | null } | Record<string, string>; message?: string } | null;
  const h = e?.headers;
  const header = typeof h?.get === "function" ? h.get("retry-after") : (h as Record<string, string> | undefined)?.["retry-after"];
  const fromHeader = header ? Number(header) : NaN;
  if (Number.isFinite(fromHeader) && fromHeader >= 0) return fromHeader * 1000;
  const text = `${e?.message ?? ""} ${String(err)}`;
  const m = text.match(/retry in ([\d.]+)\s*s/i) ?? text.match(/"retryDelay"\s*:\s*"([\d.]+)s"/i);
  return m ? Math.ceil(Number(m[1]) * 1000) : undefined;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { retries = 4, baseDelayMs = 1000, maxRetryAfterMs = 90_000, isRetryable = isTransient } = opts;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    opts.signal?.throwIfAborted();
    try {
      return await fn();
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      if (attempt >= retries || !isRetryable(err)) throw err;
      const backoff = baseDelayMs * 2 ** attempt * (0.75 + Math.random() * 0.5);
      const asked = retryAfterMs(err);
      // Wait at least as long as the server asked (plus a second of slack), never less than our own backoff.
      const waitMs = asked === undefined ? backoff : Math.max(backoff, Math.min(asked + 1000, maxRetryAfterMs));
      opts.onRetry?.({ attempt: attempt + 1, waitMs, error: err });
      if (!opts.sleep && opts.signal) {
        await new Promise<void>((resolve, reject) => {
          const signal = opts.signal!;
          const abort = () => { clearTimeout(timer); reject(signal.reason); };
          const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, waitMs);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
      } else await sleep(waitMs);
    }
  }
}
