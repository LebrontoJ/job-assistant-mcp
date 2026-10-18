import { describe, expect, it } from "vitest";
import { runAgent } from "../src/agent/loop.js";
import type { ChatRequest, ChatResponse, LLMClient } from "../src/agent/llm/types.js";
import { connectedPair } from "./helpers.js";

/** A scripted model: returns the queued responses in order and records what it was sent. */
function scripted(responses: Array<Partial<ChatResponse>>): LLMClient & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  let i = 0;
  return {
    provider: "fake",
    model: "fake",
    requests,
    async chat(req) {
      requests.push(structuredClone(req));
      const r = responses[i++] ?? { text: "out of script", finish: "stop" };
      return { text: "", toolCalls: [], finish: "stop", usage: { inputTokens: 10, outputTokens: 5 }, ...r };
    },
  };
}

describe("runAgent", () => {
  it("executes tool calls through MCP and feeds results back", async () => {
    const { client } = await connectedPair();
    const llm = scripted([
      { finish: "tool_calls", toolCalls: [{ id: "1", name: "list_followups", args: { days: 7 } }] },
      { text: "Two follow-ups due.", finish: "stop" },
    ]);

    const run = await runAgent(llm, client, "What do I need to follow up on?");

    expect(run.answer).toBe("Two follow-ups due.");
    expect(run.stoppedBecause).toBe("answered");
    expect(run.steps).toBe(2);
    expect(run.trace.map((t) => t.name)).toEqual(["list_followups"]);
    expect(run.usage).toEqual({ inputTokens: 20, outputTokens: 10 });

    const second = llm.requests[1]!;
    const toolMsg = second.messages.at(-1)!;
    expect(toolMsg.role).toBe("tool");
    expect(JSON.stringify(toolMsg)).toContain("Contoso Data");
    expect(second.tools.map((t) => t.name)).toContain("add_application");
  });

  it("surfaces tool errors to the model instead of throwing", async () => {
    const { client } = await connectedPair();
    const llm = scripted([
      { finish: "tool_calls", toolCalls: [{ id: "1", name: "update_application", args: { id: "zzz", status: "oa" } }] },
      { text: "That id does not exist.", finish: "stop" },
    ]);
    const run = await runAgent(llm, client, "mark zzz as OA");
    expect(run.trace[0]).toMatchObject({ name: "update_application", isError: true });
    expect(run.answer).toBe("That id does not exist.");
  });

  it("turns an unknown tool into an error result", async () => {
    const { client } = await connectedPair();
    const llm = scripted([
      { finish: "tool_calls", toolCalls: [{ id: "1", name: "does_not_exist", args: {} }] },
      { text: "ok", finish: "stop" },
    ]);
    const run = await runAgent(llm, client, "x");
    expect(run.trace[0]?.isError).toBe(true);
  });

  it("stops at maxSteps when the model keeps calling tools", async () => {
    const { client } = await connectedPair();
    const loop = { finish: "tool_calls" as const, toolCalls: [{ id: "1", name: "list_applications", args: {} }] };
    const run = await runAgent(scripted([loop, loop, loop, loop]), client, "x", { maxSteps: 3 });
    expect(run.stoppedBecause).toBe("max_steps");
    expect(run.trace).toHaveLength(3);
  });

  it("reports blocked and truncated responses distinctly", async () => {
    const { client } = await connectedPair();
    expect((await runAgent(scripted([{ finish: "blocked" }]), client, "x")).stoppedBecause).toBe("blocked");
    expect((await runAgent(scripted([{ text: "par", finish: "length" }]), client, "x")).stoppedBecause).toBe("truncated");
  });
});
