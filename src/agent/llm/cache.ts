import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatRequest, ChatResponse, LLMClient, Message } from "./types.js";

/** Drops fields that differ between otherwise identical runs (generated call ids, vendor raw payloads). */
function normalise(messages: Message[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "user") return m;
    if (m.role === "assistant") {
      return { role: m.role, text: m.text, toolCalls: m.toolCalls.map(({ name, args }) => ({ name, args })) };
    }
    return { role: m.role, results: m.results.map(({ name, text, isError }) => ({ name, text, isError })) };
  });
}

/**
 * Replays recorded responses for identical requests, so re-running an eval after changing only the
 * grader (or after a partial failure) costs no API quota. Keyed by provider, model and full request.
 */
export class CachingLLM implements LLMClient {
  hits = 0;
  misses = 0;

  constructor(
    private readonly inner: LLMClient,
    private readonly dir: string,
  ) {}

  get provider() {
    return this.inner.provider;
  }
  get model() {
    return this.inner.model;
  }

  key(req: ChatRequest): string {
    const payload = JSON.stringify({
      provider: this.provider,
      model: this.model,
      system: req.system,
      messages: normalise(req.messages),
      tools: req.tools,
    });
    return createHash("sha256").update(payload).digest("hex");
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const file = join(this.dir, `${this.key(req)}.json`);
    try {
      const cached = JSON.parse(await readFile(file, "utf8")) as ChatResponse;
      this.hits++;
      return cached;
    } catch {
      // miss (or unreadable entry): fall through to the real call
    }
    const res = await this.inner.chat(req);
    this.misses++;
    // Only successful completions are worth replaying; blocked/truncated ones should be retried.
    if (res.finish === "stop" || res.finish === "tool_calls") {
      await mkdir(this.dir, { recursive: true });
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(tmp, JSON.stringify(res), "utf8");
      await rename(tmp, file);
    }
    return res;
  }
}
