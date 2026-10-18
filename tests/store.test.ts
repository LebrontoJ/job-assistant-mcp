import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApplicationStore } from "../src/store/applications.js";

let dir: string;
let store: ApplicationStore;
const NOW = new Date("2026-10-16T12:00:00Z");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ja-store-"));
  store = new ApplicationStore(join(dir, "apps.json"), () => NOW);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("ApplicationStore", () => {
  it("starts empty when the file does not exist", async () => {
    expect(await store.list()).toEqual([]);
  });

  it("adds with defaults and persists", async () => {
    const a = await store.add({ company: " Acme ", role: "SWE" });
    expect(a).toMatchObject({ company: "Acme", status: "wishlist", createdAt: NOW.toISOString() });
    expect(await store.get(a.id)).toEqual(a);
  });

  it("filters by status and company substring", async () => {
    await store.add({ company: "Acme", role: "SWE", status: "applied" });
    await store.add({ company: "Globex", role: "SWE", status: "wishlist" });
    expect(await store.list({ status: "applied" })).toHaveLength(1);
    expect(await store.list({ company: "glo" })).toHaveLength(1);
  });

  it("updates only provided fields", async () => {
    const a = await store.add({ company: "Acme", role: "SWE", notes: "keep" });
    const u = await store.update(a.id, { status: "interview", notes: undefined });
    expect(u).toMatchObject({ status: "interview", notes: "keep" });
    expect(await store.update("nope", { status: "offer" })).toBeUndefined();
  });

  it("detects duplicates case-insensitively", async () => {
    await store.add({ company: "Acme", role: "SWE" });
    expect(await store.findDuplicate("acme", "swe")).toBeDefined();
    expect(await store.findDuplicate("acme", "PM")).toBeUndefined();
  });

  it("returns due follow-ups, skipping terminal statuses, sorted by date", async () => {
    await store.add({ company: "A", role: "r", status: "applied", nextFollowUp: "2026-10-30" });
    await store.add({ company: "B", role: "r", status: "interview", nextFollowUp: "2026-10-10" });
    await store.add({ company: "C", role: "r", status: "rejected", nextFollowUp: "2026-10-01" });
    await store.add({ company: "D", role: "r", status: "applied", nextFollowUp: "2026-12-01" });
    const due = await store.followups(7);
    expect(due.map((a) => a.company)).toEqual(["B"]);
    expect((await store.followups(30)).map((a) => a.company)).toEqual(["B", "A"]);
  });
});
