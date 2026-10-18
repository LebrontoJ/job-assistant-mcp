import { describe, expect, it } from "vitest";
import { connectedPair, textOf } from "./helpers.js";

describe("MCP server", () => {
  it("advertises the tools with JSON Schemas", async () => {
    const { client } = await connectedPair();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "add_application",
      "list_applications",
      "list_followups",
      "match_resume",
      "parse_jd",
      "search_profile",
      "update_application",
    ]);
    const add = tools.find((t) => t.name === "add_application")!;
    expect(add.inputSchema.required).toEqual(expect.arrayContaining(["company", "role"]));
  });

  it("lists follow-ups due within a window", async () => {
    const { client } = await connectedPair();
    const r = await client.callTool({ name: "list_followups", arguments: { days: 7 } });
    const rows = JSON.parse(textOf(r)) as Array<{ company: string }>;
    // Contoso (2026-10-12, overdue) and Northwind (2026-10-18); Adventure Works is rejected.
    expect(rows.map((x) => x.company)).toEqual(["Contoso Data", "Northwind Labs"]);
  });

  it("add_application only previews without confirm, and writes with it", async () => {
    const { client, store } = await connectedPair();
    const args = { company: "Initech", role: "SRE" };

    const preview = JSON.parse(textOf(await client.callTool({ name: "add_application", arguments: args })));
    expect(preview.status).toBe("pending_confirmation");
    expect(await store.list({ company: "initech" })).toHaveLength(0);

    const done = JSON.parse(
      textOf(await client.callTool({ name: "add_application", arguments: { ...args, confirm: true } })),
    );
    expect(done.status).toBe("created");
    expect(await store.list({ company: "initech" })).toHaveLength(1);
  });

  it("refuses duplicates even when confirmed", async () => {
    const { client } = await connectedPair();
    const r = await client.callTool({
      name: "add_application",
      arguments: { company: "northwind labs", role: "backend engineer", confirm: true },
    });
    expect(JSON.parse(textOf(r)).status).toBe("duplicate");
  });

  it("update_application previews, writes on confirm, and errors on unknown id", async () => {
    const { client, store } = await connectedPair();
    const p = JSON.parse(
      textOf(await client.callTool({ name: "update_application", arguments: { id: "e5f6a7b8", status: "oa" } })),
    );
    expect(p.status).toBe("pending_confirmation");
    expect((await store.get("e5f6a7b8"))?.status).toBe("applied");

    await client.callTool({ name: "update_application", arguments: { id: "e5f6a7b8", status: "oa", confirm: true } });
    expect((await store.get("e5f6a7b8"))?.status).toBe("oa");

    const bad = await client.callTool({ name: "update_application", arguments: { id: "zzz", status: "oa" } });
    expect(bad.isError).toBe(true);
  });

  it("rejects invalid arguments", async () => {
    const { client } = await connectedPair();
    const r = await client.callTool({ name: "list_applications", arguments: { status: "bogus" } });
    expect(r.isError).toBe(true);
  });
});
