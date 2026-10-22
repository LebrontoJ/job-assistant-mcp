import { describe, expect, it } from "vitest";
import { runAgent, SYSTEM_PROMPT } from "../src/agent/loop.js";
import type { ChatRequest, ChatResponse, LLMClient } from "../src/agent/llm/types.js";
import { connectedPair } from "./helpers.js";
import { readFileSync } from "node:fs";

const JD = readFileSync("data/sample/jd-backend.txt", "utf8");

function scripted(responses: Array<Partial<ChatResponse>>): LLMClient & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  let i = 0;
  return {
    provider: "fake",
    model: "fake",
    requests,
    async chat(req) {
      requests.push(structuredClone(req));
      return { text: "", toolCalls: [], finish: "stop", usage: { inputTokens: 1, outputTokens: 1 }, ...(responses[i++] ?? {}) };
    },
  };
}

const call = (id: string, name: string, args: Record<string, unknown>): Partial<ChatResponse> => ({
  finish: "tool_calls",
  toolCalls: [{ id, name, args }],
});

describe("JD -> match -> evidence -> tracker flow", () => {
  it("previews the write, then writes only after the user confirms in a later turn", async () => {
    const { client, store } = await connectedPair();
    const role = { company: "Initech", role: "Backend Engineer" };

    const turn1 = scripted([
      call("1", "parse_jd", { text: JD }),
      call("2", "match_resume", { jd_text: JD }),
      call("3", "search_profile", { query: "postgres latency", k: 2 }),
      call("4", "add_application", { ...role, status: "wishlist" }),
      { text: "Cut PostgreSQL p95 query latency by 38% through index and query redesign. [resume.md#0]", finish: "stop" },
    ]);
    const run1 = await runAgent(turn1, client, "Tailor my resume to this JD and track it.", { maxSteps: 10 });

    expect(run1.trace.map((t) => t.name)).toEqual(["parse_jd", "match_resume", "search_profile", "add_application"]);
    expect(run1.stoppedBecause).toBe("answered");
    expect(JSON.parse(run1.trace[3]!.result).status).toBe("pending_confirmation");
    expect(await store.list({ company: "initech" })).toHaveLength(0);

    const turn2 = scripted([
      call("5", "add_application", { ...role, status: "wishlist", confirm: true }),
      { text: "Added.", finish: "stop" },
    ]);
    const run2 = await runAgent(turn2, client, "Yes, add it.", { history: run1.messages });

    expect(JSON.parse(run2.trace[0]!.result).status).toBe("created");
    expect(await store.list({ company: "initech" })).toHaveLength(1);
    // The second turn saw the whole first turn, including the preview it is confirming.
    expect(turn2.requests[0]!.messages.length).toBeGreaterThan(8);
  });

  it("gives the model the grounding rules and the full tool surface", async () => {
    const { client } = await connectedPair();
    const llm = scripted([{ text: "hi", finish: "stop" }]);
    await runAgent(llm, client, "hello");
    const req = llm.requests[0]!;
    expect(req.system).toBe(SYSTEM_PROMPT);
    expect(req.system).toMatch(/Cite the passage id/);
    expect(req.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["search_profile", "match_resume", "add_application"]));
  });

  it("exposes MCP prompts that point at the right tools", async () => {
    const { client } = await connectedPair();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["tailor-resume", "weekly-review"]);
    const got = await client.getPrompt({ name: "tailor-resume", arguments: { jd_text: JD } });
    const text = (got.messages[0]!.content as { text: string }).text;
    expect(text).toMatch(/match_resume/);
    expect(text).toContain("Northwind Labs");
  });
});
