import { describe, expect, it } from "vitest";
import { sanitizeSchema, toContents, toDeclarations } from "../src/agent/llm/gemini.js";
import { createLLM } from "../src/agent/llm/index.js";
import { isTransient, withRetry } from "../src/agent/llm/retry.js";

describe("gemini adapter helpers", () => {
  it("strips schema keywords Gemini rejects, recursively", () => {
    const out = sanitizeSchema({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      additionalProperties: false,
      properties: { a: { type: "object", additionalProperties: false, properties: {} } },
    });
    expect(JSON.stringify(out)).not.toMatch(/additionalProperties|\$schema/);
    expect(out).toMatchObject({ type: "object" });
  });

  it("builds function declarations", () => {
    const [d] = toDeclarations([{ name: "t", description: "d", inputSchema: { type: "object", $schema: "x" } }]);
    expect(d).toEqual({ name: "t", description: "d", parametersJsonSchema: { type: "object" } });
  });

  it("maps messages, replaying raw assistant content verbatim", () => {
    const raw = { role: "model", parts: [{ functionCall: { name: "t", args: {} }, thoughtSignature: "sig" }] };
    const contents = toContents([
      { role: "user", text: "hi" },
      { role: "assistant", text: "", toolCalls: [{ id: "1", name: "t", args: {} }], raw },
      { role: "tool", results: [{ callId: "1", name: "t", text: "ok" }] },
      { role: "tool", results: [{ callId: "2", name: "t", text: "boom", isError: true }] },
    ]);
    expect(contents[1]).toBe(raw);
    expect(contents[2]).toEqual({
      role: "user",
      parts: [{ functionResponse: { name: "t", response: { output: "ok" } } }],
    });
    expect(contents[3]?.parts?.[0]?.functionResponse?.response).toEqual({ error: "boom" });
  });

  it("builds assistant content from text + tool calls when there is no raw", () => {
    const [c] = toContents([{ role: "assistant", text: "x", toolCalls: [{ id: "1", name: "t", args: { a: 1 } }] }]);
    expect(c).toEqual({ role: "model", parts: [{ text: "x" }, { functionCall: { name: "t", args: { a: 1 } } }] });
  });
});

describe("retry", () => {
  const noSleep = async () => {};

  it("retries transient failures then succeeds", async () => {
    let n = 0;
    const out = await withRetry(
      async () => {
        if (++n < 3) throw Object.assign(new Error("rate"), { status: 429 });
        return "ok";
      },
      { sleep: noSleep },
    );
    expect(out).toBe("ok");
    expect(n).toBe(3);
  });

  it("does not retry client errors", async () => {
    let n = 0;
    await expect(
      withRetry(async () => { n++; throw Object.assign(new Error("bad"), { status: 400 }); }, { sleep: noSleep }),
    ).rejects.toThrow("bad");
    expect(n).toBe(1);
  });

  it("gives up after the retry budget", async () => {
    let n = 0;
    await expect(
      withRetry(async () => { n++; throw Object.assign(new Error("x"), { status: 503 }); }, { retries: 2, sleep: noSleep }),
    ).rejects.toThrow("x");
    expect(n).toBe(3);
  });

  it("classifies errors", () => {
    expect(isTransient({ status: 429 })).toBe(true);
    expect(isTransient({ status: 404 })).toBe(false);
    expect(isTransient(new Error("fetch failed"))).toBe(true);
  });
});

describe("createLLM", () => {
  it("requires the API key", () => {
    expect(() => createLLM({}, {})).toThrow(/GEMINI_API_KEY/);
  });
  it("rejects unknown providers", () => {
    expect(() => createLLM({ provider: "nope" }, {})).toThrow(/Unknown LLM provider/);
  });
  it("builds a gemini client with an env-selected model", () => {
    const llm = createLLM({}, { GEMINI_API_KEY: "k", LLM_MODEL: "m1" });
    expect(llm).toMatchObject({ provider: "gemini", model: "m1" });
  });
});
