import { describe, expect, it } from "vitest";
import { AnthropicClient, FALLBACK_BETA, toMessages, toTools, type AnthropicLike, type WireResponse } from "../src/agent/llm/anthropic.js";
import { createLLM } from "../src/agent/llm/index.js";
import { createEmbedder } from "../src/rag/factory.js";
import type { Message } from "../src/agent/llm/types.js";

function fake(responses: Array<WireResponse | Error>) {
  const calls: Array<{ beta: boolean; params: Record<string, unknown> }> = [];
  let i = 0;
  const next = async (beta: boolean, params: Record<string, unknown>) => {
    calls.push({ beta, params });
    const r = responses[i++] ?? responses.at(-1)!;
    if (r instanceof Error) throw r;
    return r;
  };
  const api: AnthropicLike = {
    messages: { create: (p) => next(false, p) },
    beta: { messages: { create: (p) => next(true, p) } },
  };
  return { api, calls };
}
const ok = (over: Partial<WireResponse> = {}): WireResponse => ({
  content: [{ type: "text", text: "hi" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 4 },
  ...over,
});
const req = { system: "sys", tools: [], messages: [{ role: "user", text: "q" }] satisfies Message[] };

describe("anthropic message mapping", () => {
  it("maps tool specs to input_schema", () => {
    expect(toTools([{ name: "t", description: "d", inputSchema: { type: "object", properties: {} } }])).toEqual([
      { name: "t", description: "d", input_schema: { type: "object", properties: {} } },
    ]);
  });

  it("maps user, assistant and tool messages, batching parallel results into one user turn", () => {
    const out = toMessages([
      { role: "user", text: "q" },
      { role: "assistant", text: "let me look", toolCalls: [{ id: "a", name: "t", args: { x: 1 } }, { id: "b", name: "u", args: {} }] },
      { role: "tool", results: [{ callId: "a", name: "t", text: "r1" }, { callId: "b", name: "u", text: "boom", isError: true }] },
    ]);
    expect(out[0]).toEqual({ role: "user", content: "q" });
    expect(out[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "let me look" },
        { type: "tool_use", id: "a", name: "t", input: { x: 1 } },
        { type: "tool_use", id: "b", name: "u", input: {} },
      ],
    });
    expect(out[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "a", content: "r1" },
        { type: "tool_result", tool_use_id: "b", content: "boom", is_error: true },
      ],
    });
  });

  it("replays the model's own content blocks verbatim, thinking included", () => {
    const raw = [{ type: "thinking", thinking: "", signature: "sig" }, { type: "tool_use", id: "a", name: "t", input: {} }];
    const [m] = toMessages([{ role: "assistant", text: "", toolCalls: [{ id: "a", name: "t", args: {} }], raw }]);
    expect((m as { content: unknown }).content).toBe(raw);
  });
});

describe("AnthropicClient", () => {
  it("sends a plain request when fallback is off, with only what it was given", async () => {
    const { api, calls } = fake([ok()]);
    const llm = new AnthropicClient("claude-opus-5-5", { client: api, fallback: false });
    const res = await llm.chat({ ...req, tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }] });
    expect(res).toMatchObject({ text: "hi", finish: "stop", toolCalls: [], usage: { inputTokens: 10, outputTokens: 4 } });
    const { beta, params } = calls[0]!;
    expect(beta).toBe(false);
    expect(params).toMatchObject({ model: "claude-opus-5-5", max_tokens: 16000, system: "sys" });
    expect(params).not.toHaveProperty("output_config");
    expect(params).not.toHaveProperty("tool_choice");
    expect(params).not.toHaveProperty("thinking");
    expect(params.tools).toHaveLength(1);
  });

  it("omits tools when none are given and passes effort when set", async () => {
    const { api, calls } = fake([ok()]);
    await new AnthropicClient("m", { client: api, effort: "low" }).chat(req);
    expect(calls[0]!.params).not.toHaveProperty("tools");
    expect(calls[0]!.params.output_config).toEqual({ effort: "low" });
  });

  it("uses the beta endpoint with the server-side fallback header when enabled", async () => {
    const { api, calls } = fake([ok()]);
    await new AnthropicClient("claude-opus-5-5", { client: api, fallback: true }).chat(req);
    expect(calls[0]!.beta).toBe(true);
    expect(calls[0]!.params).toMatchObject({ betas: [FALLBACK_BETA], fallbacks: "default" });
  });

  it("extracts tool calls, ignores thinking blocks in text, and keeps raw content", async () => {
    const content = [
      { type: "thinking", thinking: "" },
      { type: "text", text: "Checking." },
      { type: "tool_use", id: "toolu_1", name: "list_followups", input: { days: 7 } },
    ];
    const { api } = fake([ok({ content, stop_reason: "tool_use" })]);
    const res = await new AnthropicClient("m", { client: api }).chat(req);
    expect(res.text).toBe("Checking.");
    expect(res.toolCalls).toEqual([{ id: "toolu_1", name: "list_followups", args: { days: 7 } }]);
    expect(res.finish).toBe("tool_calls");
    expect(res.raw).toBe(content);
  });

  it("maps stop reasons: refusal is blocked, max_tokens is length", async () => {
    const run = async (stop: string | null) => {
      const { api } = fake([ok({ content: [], stop_reason: stop })]);
      return (await new AnthropicClient("m", { client: api }).chat(req)).finish;
    };
    expect(await run("refusal")).toBe("blocked");
    expect(await run("max_tokens")).toBe("length");
    expect(await run("end_turn")).toBe("stop");
    expect(await run("pause_turn")).toBe("other");
  });

  it("counts cached input tokens in usage", async () => {
    const { api } = fake([ok({ usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } })]);
    expect((await new AnthropicClient("m", { client: api }).chat(req)).usage).toEqual({ inputTokens: 125, outputTokens: 2 });
  });

  it("retries transient API errors but not client errors", async () => {
    const transient = Object.assign(new Error("overloaded"), { status: 529 });
    const first = fake([transient, ok()]);
    // retry sleeps use real timers; the first backoff is ~1s, so keep this to a single retry
    expect((await new AnthropicClient("m", { client: first.api }).chat(req)).text).toBe("hi");
    expect(first.calls).toHaveLength(2);

    const bad = fake([Object.assign(new Error("bad request"), { status: 400 })]);
    await expect(new AnthropicClient("m", { client: bad.api }).chat(req)).rejects.toThrow("bad request");
    expect(bad.calls).toHaveLength(1);
  });
});

describe("createLLM with anthropic", () => {
  it("defaults to claude-opus-5-5 and needs no key at construction", () => {
    const llm = createLLM({ provider: "anthropic" }, { LLM_PROVIDER: "gemini", LLM_MODEL: "gemini-x" });
    expect(llm).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5" });
  });
  it("accepts the 'claude' alias and an explicit model", () => {
    expect(createLLM({ provider: "claude", model: "claude-sonnet-5-5" }, {})).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5" });
  });
  it("uses LLM_MODEL only for the provider it belongs to", () => {
    const env = { LLM_PROVIDER: "anthropic", LLM_MODEL: "claude-haiku-5-5" };
    expect(createLLM({}, env).model).toBe("claude-haiku-5-5");
    expect(createLLM({ provider: "gemini" }, { ...env, GEMINI_API_KEY: "k" }).model).not.toBe("claude-haiku-5-5");
  });
});

describe("createEmbedder", () => {
  it("is off by default and explains that local is not available yet", () => {
    expect(createEmbedder(undefined)).toBeUndefined();
    expect(createEmbedder("none")).toBeUndefined();
    expect(() => createEmbedder("local")).toThrow(/not implemented yet/);
    expect(() => createEmbedder("bogus")).toThrow(/Unknown EMBEDDINGS/);
  });
});
