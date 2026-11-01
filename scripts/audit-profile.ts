import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { ProfileIndex } from "../src/rag/index.js";
import { auditProfile, ProfileAuditSchema } from "../evals/profile-audit.js";

// Deliberately does not load .env or instantiate an embedder/LLM: always offline.
const args = process.argv.slice(2);
const get = (flag: string) => {
  const i = args.indexOf(flag);
  if (i < 0 || !args[i + 1] || args[i + 1]!.startsWith("--")) throw new Error(`Required: ${flag} <path>`);
  return args[i + 1]!;
};
const profileDir = get("--profile-dir");
const casesFile = get("--cases");
const output = get("--output");
const caseText = await readFile(casesFile, "utf8");
const suite = ProfileAuditSchema.parse(JSON.parse(caseText));
const index = await ProfileIndex.fromDir(profileDir);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const report = { date: new Date().toISOString(), profileDir, casesFile,
  corpusHash: hash(JSON.stringify(index.chunks)), suiteHash: hash(caseText),
  ...await auditProfile(index, suite) };
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ passed: report.passed, chunks: report.chunks, retrieval: report.retrieval.summary,
  claims: { passed: report.claims.filter(c => c.passed).length, total: report.claims.length },
  content: { passed: report.content.filter(c => c.passed).length, total: report.content.length }, output,
  scope: report.scope }, null, 2));
if (!report.passed) process.exitCode = 1;
