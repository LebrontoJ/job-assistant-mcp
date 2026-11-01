import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { auditProfile, ProfileAuditSchema } from "../evals/profile-audit.js";
import { ProfileIndex } from "../src/rag/index.js";

// Entirely synthetic fixture. Private files are never required by CI.
const files = {
  "work/billing.md": "# Acme\n## Trial reminders\nThe local TRIAL state controls reminder eligibility. Event reordering caused reminder emails to be missed.\n\n## Timing\nReduced average latency from 8s to 6s using parallel calls.",
};
const suite = () => ProfileAuditSchema.parse({
  retrieval: [{ id: "reminder", query: "trial reminder", relevant: [{ source: "work/billing.md", heading: "Trial reminders" }] }],
  claims: [
    { id: "extract", query: "average latency parallel", claim: "Reduced average latency from 8s to 6s using parallel calls.", evidence: { source: "work/billing.md", heading: "Timing" }, expectedSupported: true },
    { id: "wrong_statistic", query: "average latency parallel", claim: "Reduced p95 latency from 8s to 6s using parallel calls.", evidence: { source: "work/billing.md", heading: "Timing" }, expectedSupported: false },
  ],
  content: [{ id: "corrected_impact", section: { source: "work/billing.md", heading: "Trial reminders" }, required: ["reminder emails", "TRIAL"], forbidden: ["permanent access"] }],
});

describe("offline profile audit", () => {
  it("checks nested-source retrieval, grounded extracts, changed metrics and corrected impact", async () => {
    const report = await auditProfile(ProfileIndex.fromMarkdown(files), suite());
    expect(report.passed).toBe(true);
    expect(report.claims.map(c => c.supported)).toEqual([true, false]);
    expect(report.claims[1]?.reason).toBe("quantity_not_grounded_in_same_claim");
    expect(report.retrieval.summary.recallAt[1]).toBe(1);
  });

  it("catches stale corrections and missing source labels", async () => {
    const index = ProfileIndex.fromMarkdown({ "work/billing.md": files["work/billing.md"] + "\n\n## Trial reminders\nThe bug gave permanent access." });
    expect((await auditProfile(index, suite())).content[0]?.passed).toBe(false);
    const bad = suite();
    bad.retrieval[0]!.relevant[0]!.heading = "Removed section";
    await expect(auditProfile(index, bad)).rejects.toThrow("Missing audit section");
  });

  it("does not count a negative claim as correct when its evidence was never retrieved", async () => {
    const bad = suite();
    bad.claims = [{ ...bad.claims[1]!, query: "unfindable_xyz" }];
    const report = await auditProfile(ProfileIndex.fromMarkdown(files), bad);
    expect(report.passed).toBe(false);
    expect(report.claims[0]).toMatchObject({ passed: false, reason: "expected_evidence_not_retrieved" });
  });
});

describe("custom evaluation CLI", () => {
  it("does not load retrieval cases when running match-only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ja-match-only-"));
    try {
      await writeFile(join(dir, "profile.md"), "## APIs\nBuilt Python services.");
      const path = join(dir, "matches.jsonl");
      await writeFile(path, JSON.stringify({ id: "python", item: "Python services", truth: "supported", split: "dev" }) + "\n");
      const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "evals/run.ts", "--match-only", "--embeddings", "none", "--profile-dir", dir, "--match-cases", path, "--retrieval-cases", join(dir, "does-not-exist.jsonl")]);
      expect(stdout).toContain("keyword only");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("uses a separate profile and retrieval suite without a key or modifying the sample fixtures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ja-custom-eval-"));
    try {
      await mkdir(join(dir, "work"));
      await writeFile(join(dir, "work/billing.md"), files["work/billing.md"]);
      const path = join(dir, "queries.jsonl");
      await writeFile(path, JSON.stringify(suite().retrieval[0]) + "\n");
      const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "evals/run.ts", "--retrieval-only", "--embeddings", "none", "--profile-dir", dir, "--retrieval-cases", path]);
      expect(stdout).toContain("1.00");
      expect(stdout).not.toContain("r_postgres_paraphrase");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
