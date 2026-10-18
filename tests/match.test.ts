import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ProfileIndex } from "../src/rag/index.js";
import { parseJd } from "../src/server/jd.js";
import { matchProfile } from "../src/server/match.js";
import { connectedPair, textOf } from "./helpers.js";

const jd = parseJd(readFileSync("data/sample/jd-backend.txt", "utf8"));

describe("matchProfile", () => {
  it("finds evidence with citable chunk ids and flags what is missing", async () => {
    const idx = await ProfileIndex.fromDir("data/sample/profile");
    const r = await matchProfile(jd, idx);

    const pg = r.items.find((i) => i.item.startsWith("Strong knowledge of PostgreSQL"))!;
    expect(pg.support).not.toBe("no_evidence");
    expect(pg.evidence.length).toBeGreaterThan(0);
    expect(idx.chunks.map((c) => c.id)).toContain(pg.evidence[0]!.chunkId);

    const kafka = r.items.find((i) => i.item.includes("Kafka"))!;
    expect(kafka.kind).toBe("nice_to_have");
    expect(kafka.support).not.toBe("no_evidence");

    expect(r.skills.find((s) => s.skill === "Python")?.found).toBe(true);
    expect(r.summary.skillsMissing).toContain("gRPC");
    expect(r.summary.skillsMissing).not.toContain("PostgreSQL");
  });

  it("reports no evidence for an unrelated requirement", async () => {
    const idx = ProfileIndex.fromMarkdown({ "r.md": "## Work\n- Wrote Python services" });
    const r = await matchProfile(
      { ...jd, requirements: ["Deep expertise in Haskell compilers"], niceToHave: [], skills: [] },
      idx,
    );
    expect(r.items[0]).toMatchObject({ support: "no_evidence", evidence: [] });
  });
});

describe("profile tools over MCP", () => {
  it("search_profile returns cited passages", async () => {
    const { client } = await connectedPair();
    const out = JSON.parse(textOf(await client.callTool({ name: "search_profile", arguments: { query: "docker CI pipeline", k: 2 } })));
    expect(out.hits.length).toBeGreaterThan(0);
    expect(out.hits[0]).toHaveProperty("id");
    expect(JSON.stringify(out.hits)).toMatch(/Docker/);
  });

  it("match_resume runs on raw JD text", async () => {
    const { client } = await connectedPair();
    const r = await client.callTool({ name: "match_resume", arguments: { jd_text: readFileSync("data/sample/jd-backend.txt", "utf8") } });
    const out = JSON.parse(textOf(r));
    expect(out.items.length).toBe(jd.requirements.length + jd.niceToHave.length);
    expect(out.note).toMatch(/word overlap/);
  });
});
