import type { ChatRequest, ChatResponse, LLMClient } from "./types.js";

/**
 * Stamps each response with how long the model API call took. It must sit directly on the provider client, under
 * the rate limiter and the cache: above them the number would include queueing, and a cache hit would read ~0ms.
 * Stored in the cache with the response, a replayed hit reports the latency of the original live call.
 */
export class TimedLLM implements LLMClient {
  constructor(private readonly inner: LLMClient) {}
  get provider() {
    return this.inner.provider;
  }
  get model() {
    return this.inner.model;
  }
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const start = performance.now();
    const res = await this.inner.chat(req);
    return { ...res, latencyMs: Math.round(performance.now() - start) };
  }
}
