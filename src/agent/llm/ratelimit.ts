import type { ChatRequest, ChatResponse, LLMClient } from "./types.js";

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/**
 * Spaces out live calls to at most `rpm` per minute, so a free-tier quota is respected up front instead of being
 * discovered through 429s. Put it under CachingLLM: cache hits then cost nothing and never wait.
 */
export class RateLimitedLLM implements LLMClient {
  private nextAt = 0;
  private readonly interval: number;

  constructor(
    private readonly inner: LLMClient,
    rpm: number,
    private readonly clock: Clock = realClock,
  ) {
    if (!(rpm > 0)) throw new Error(`rpm must be positive, got ${rpm}`);
    this.interval = 60_000 / rpm;
  }

  get provider() {
    return this.inner.provider;
  }
  get model() {
    return this.inner.model;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    // Reserve the slot synchronously so concurrent callers queue behind each other.
    const start = Math.max(this.clock.now(), this.nextAt);
    this.nextAt = start + this.interval;
    const wait = start - this.clock.now();
    if (wait > 0) await this.clock.sleep(wait);
    return this.inner.chat(req);
  }
}
