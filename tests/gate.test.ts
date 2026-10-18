import { describe, expect, it } from "vitest";
import { citationProblem, citedIds } from "../src/agent/citations.js";
import { checkWriteGate } from "../src/agent/gate.js";
import { runAgent } from "../src/agent/loop.js";
import type { ChatRequest, ChatResponse, LLMClient, Message } from "../src/agent/llm/types.js";
import { connectedPair } from "./helpers.js";

const add = (confirm?: boolean) => ({ id: "1", name: "add_application", args: { company: "Initech", role: "SRE", ...(confirm ? { confirm } : {}) } });
const preview = JSON.stringify({ status: "pending_confirmation", preview: { company: "Initech", role: "SRE" } });
const previewMsgs = (): Message[] => [
  { role: "user", text: "add Initech" },
  { role: "assistant", text: "", toolCalls: [add()] },
  { role: "tool", results: [{ callId: "1", name: "add_application", text: preview }] },
];

describe("checkWriteGate", () => {
  it("lets previews and non-write tools through", () => {
    expect(checkWriteGate([], add()).allowed).toBe(true);
    expect(checkWriteGate([], { id: "x", name: "list_applications", args: { confirm: true } }).allowed).toBe(true);
  });

  it("blocks a confirmed write with no preview at all", () => {
    const d = checkWriteGate([{ role: "user", text: "add Initech, and yes I confirm" }], add(true));
    expect(d).toMatchObject({ allowed: false, reason: expect.stringMatching(/no preview/) });
  });

  it("blocks confirm in the same turn as the preview: no user reply yet", () => {
    expect(checkWriteGate(previewMsgs(), add(true))).toMatchObject({ allowed: false, reason: expect.stringMatching(/not replied/) });
  });

  it("allows it after a real user reply", () => {
    expect(checkWriteGate([...previewMsgs(), { role: "assistant", text: "Shall I?", toolCalls: [] }, { role: "user", text: "yes" }], add(true)).allowed).toBe(true);
  });

  it("does not treat a host-injected reminder as the user's reply", () => {
    const msgs: Message[] = [...previewMsgs(), { role: "assistant", text: "x", toolCalls: [] }, { role: "user", text: "cite your sources", synthetic: true }];
    expect(checkWriteGate(msgs, add(true)).allowed).toBe(false);
  });

  it("a preview of a different change does not unlock this one", () => {
    const other = { ...add(true), args: { company: "Other", role: "SRE", confirm: true } };
    expect(checkWriteGate([...previewMsgs(), { role: "user", text: "yes" }], other).allowed).toBe(false);
  });

  it("matches update previews by application id", () => {
    const up = JSON.stringify({ status: "pending_confirmation", current: { id: "e5f6a7b8" }, changes: {} });
    const msgs: Message[] = [
      { role: "assistant", text: "", toolCalls: [{ id: "1", name: "update_application", args: { id: "e5f6a7b8", status: "oa" } }] },
      { role: "tool", results: [{ callId: "1", name: "update_application", text: up }] },
      { role: "user", text: "yes" },
    ];
    expect(checkWriteGate(msgs, { id: "2", name: "update_application", args: { id: "e5f6a7b8", status: "oa", confirm: true } }).allowed).toBe(true);
    expect(checkWriteGate(msgs, { id: "2", name: "update_application", args: { id: "other", confirm: true } }).allowed).toBe(false);
  });
});

describe("citations", () => {
  const hit = (id: string, keywordCoverage: number) => JSON.stringify({ hits: [{ id, keywordCoverage }] });
  const tool = (text: string): Message => ({ role: "tool", results: [{ callId: "1", name: "search_profile", text }] });
  const trace = (text: string) => [{ name: "search_profile", args: {}, result: text, isError: false }];

  it("extracts distinct ids", () => {
    expect(citedIds("see [resume.md#0, stories.md#1] and resume.md#0")).toEqual(["resume.md#0", "stories.md#1"]);
  });

  it("flags ids no tool returned", () => {
    expect(citationProblem("done [resume.md#9]", [tool(hit("resume.md#0", 1))], trace(hit("resume.md#0", 1)))).toMatch(/resume\.md#9/);
  });

  it("flags an uncited answer only when strongly matching passages were retrieved", () => {
    const strong = hit("resume.md#0", 0.8);
    expect(citationProblem("You cut latency 38%.", [tool(strong)], trace(strong))).toMatch(/cites no passage ids/);
    expect(citationProblem("You cut latency 38% [resume.md#0].", [tool(strong)], trace(strong))).toBeUndefined();
  });

  it("does not penalise a 'nothing found' answer built on weak retrieval", () => {
    const weak = hit("resume.md#0", 0.1);
    expect(citationProblem("I found nothing about Rust.", [tool(weak)], trace(weak))).toBeUndefined();
    expect(citationProblem("No tools were used.", [], [])).toBeUndefined();
  });

  it("reads match_resume evidence, strong only when supported", () => {
    const m = (support: string) => JSON.stringify({ items: [{ support, evidence: [{ chunkId: "projects.md#0" }] }] });
    const msg = (t: string): Message => ({ role: "tool", results: [{ callId: "1", name: "match_resume", text: t }] });
    const tr = (t: string) => [{ name: "match_resume", args: {}, result: t, isError: false }];
    expect(citationProblem("Kafka yes.", [msg(m("supported"))], tr(m("supported")))).toBeDefined();
    expect(citationProblem("Maybe.", [msg(m("weak"))], tr(m("weak")))).toBeUndefined();
  });
});

function scripted(responses: Array<Partial<ChatResponse>>): LLMClient & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  let i = 0;
  return {
    provider: "fake",
    model: "fake",
    requests,
    async chat(req) {
      requests.push(structuredClone(req));
      return { text: "", toolCalls: [], finish: "stop", usage: { inputTokens: 1, outputTokens: 1 }, ...(responses[i++] ?? { text: "done" }) };
    },
  };
}
const call = (name: string, args: Record<string, unknown>): Partial<ChatResponse> => ({ finish: "tool_calls", toolCalls: [{ id: `c${Math.random()}`, name, args }] });

describe("agent loop enforcement", () => {
  const init = { company: "Initech", role: "Site Reliability Engineer", status: "wishlist" };

  it("refuses a confirmed write that skips the preview, reports it, and writes nothing", async () => {
    const { client, store } = await connectedPair();
    const run = await runAgent(scripted([call("add_application", { ...init, confirm: true }), { text: "I could not add it." }]), client, "add Initech");
    expect(run.blockedWrites).toBe(1);
    expect(run.trace[0]).toMatchObject({ blocked: true, isError: true });
    expect(await store.list({ company: "initech" })).toHaveLength(0);
    // the model is told why, so it can recover
    expect(JSON.stringify(run.messages)).toMatch(/Blocked by the host/);
  });

  it("allows the same write after preview + a user reply across turns", async () => {
    const { client, store } = await connectedPair();
    const t1 = await runAgent(scripted([call("add_application", init), { text: "Add it?" }]), client, "add Initech");
    expect(t1.blockedWrites).toBe(0);
    const t2 = await runAgent(scripted([call("add_application", { ...init, confirm: true }), { text: "Added." }]), client, "yes", { history: t1.messages });
    expect(t2.blockedWrites).toBe(0);
    expect(await store.list({ company: "initech" })).toHaveLength(1);
  });

  it("can be switched off", async () => {
    const { client, store } = await connectedPair();
    await runAgent(scripted([call("add_application", { ...init, confirm: true }), { text: "ok" }]), client, "add", { writeGate: false });
    expect(await store.list({ company: "initech" })).toHaveLength(1);
  });

  it("sends the model back once to fix missing citations, using a synthetic message", async () => {
    const { client, store } = await connectedPair();
    const llm = scripted([
      call("search_profile", { query: "PostgreSQL query latency" }),
      { text: "You cut latency by 38%." },          // strong retrieval, no citation -> retry
      { text: "You cut latency by 38% [resume.md#0]." },
    ]);
    const run = await runAgent(llm, client, "What did I do with PostgreSQL?");
    expect(run.citationRetries).toBe(1);
    expect(run.answer).toContain("[resume.md#0]");
    expect(run.steps).toBe(3);
    const reminder = llm.requests[2]!.messages.at(-1)!;
    expect(reminder).toMatchObject({ role: "user", synthetic: true });
  });

  it("does not retry twice, and skips the guard when disabled", async () => {
    const { client } = await connectedPair();
    const bad = { text: "Latency cut 38%." };
    const twice = scripted([call("search_profile", { query: "PostgreSQL query latency" }), bad, bad, bad]);
    const run = await runAgent(twice, client, "q");
    expect(run.citationRetries).toBe(1);
    expect(run.answer).toBe("Latency cut 38%.");
    const off = await runAgent(scripted([call("search_profile", { query: "PostgreSQL query latency" }), bad]), client, "q", { citationGuard: false });
    expect(off.citationRetries).toBe(0);
  });
});
