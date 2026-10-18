import Anthropic from "@anthropic-ai/sdk";
import { withRetry } from "./retry.js";
import type { ChatRequest, ChatResponse, LLMClient, Message, ToolCall, ToolSpec } from "./types.js";

/** The slice of the SDK this adapter touches, so tests can inject a fake. */
export interface AnthropicLike {
  messages: { create(params: Record<string, unknown>): Promise<WireResponse> };
  beta: { messages: { create(params: Record<string, unknown>): Promise<WireResponse> } };
}

interface WireBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}
export interface WireResponse {
  content: WireBlock[];
  stop_reason: string | null;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
}

export interface AnthropicOptions {
  /** Omit to use the SDK's own credential resolution (env var or `ant auth login` profile). */
  apiKey?: string;
  maxTokens?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /**
   * Server-side refusal fallback (`fallbacks: "default"`, beta header server-side-fallback-2026-07-01).
   * Claude API only; turn it off for Bedrock/Vertex/Foundry, which reject it.
   */
  fallback?: boolean;
  client?: AnthropicLike;
}

export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export function toTools(tools: ToolSpec[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
}

export function toMessages(messages: Message[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    switch (m.role) {
      case "user":
        return { role: "user", content: m.text };
      case "assistant": {
        // Replay the model's own content blocks verbatim: thinking blocks must come back unchanged.
        if (m.raw) return { role: "assistant", content: m.raw };
        const content: Array<Record<string, unknown>> = [];
        if (m.text) content.push({ type: "text", text: m.text });
        for (const c of m.toolCalls) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.args });
        return { role: "assistant", content };
      }
      case "tool":
        return {
          role: "user",
          content: m.results.map((r) => ({
            type: "tool_result",
            tool_use_id: r.callId,
            content: r.text,
            ...(r.isError ? { is_error: true } : {}),
          })),
        };
    }
  });
}

export function toFinish(stop: string | null, hasToolCalls: boolean): ChatResponse["finish"] {
  if (hasToolCalls || stop === "tool_use") return "tool_calls";
  switch (stop) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "refusal":
      return "blocked";
    default:
      return "other";
  }
}

export class AnthropicClient implements LLMClient {
  readonly provider = "anthropic";
  private readonly api: AnthropicLike;

  constructor(
    readonly model: string,
    private readonly opts: AnthropicOptions = {},
  ) {
    // Retries live in withRetry so backoff behaves the same across providers.
    this.api =
      opts.client ?? (new Anthropic({ apiKey: opts.apiKey, maxRetries: 0 }) as unknown as AnthropicLike);
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const params: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.opts.maxTokens ?? 16000,
      system: req.system,
      messages: toMessages(req.messages),
      ...(req.tools.length ? { tools: toTools(req.tools) } : {}),
      ...(this.opts.effort ? { output_config: { effort: this.opts.effort } } : {}),
    };

    const useFallback = this.opts.fallback ?? false;
    const res = await withRetry(() =>
      useFallback
        ? this.api.beta.messages.create({ ...params, betas: [FALLBACK_BETA], fallbacks: "default" })
        : this.api.messages.create(params),
    );

    const toolCalls: ToolCall[] = res.content
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ id: b.id ?? "", name: b.name ?? "", args: (b.input ?? {}) as Record<string, unknown> }));
    const text = res.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    const u = res.usage ?? {};

    return {
      text,
      toolCalls,
      finish: toFinish(res.stop_reason, toolCalls.length > 0),
      raw: res.content,
      usage: {
        inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        outputTokens: u.output_tokens ?? 0,
      },
    };
  }
}
