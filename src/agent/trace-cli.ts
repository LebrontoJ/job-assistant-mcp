import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { formatStats, formatTrace, parseTrace, summarizeEvents, type TraceEvent } from "./trace.js";

// pnpm trace <file.jsonl | directory>   Prints a timeline per run, then aggregate performance.
const target = process.argv[2];
if (!target) {
  console.error("usage: pnpm trace <trace.jsonl | directory of .jsonl files>");
  process.exit(1);
}

const files = statSync(target).isDirectory()
  ? readdirSync(target, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".jsonl")).sort().map((f) => join(target, f))
  : [target];

const all: TraceEvent[] = [];
for (const file of files) {
  const events = parseTrace(readFileSync(file, "utf8"));
  all.push(...events);
  // One file can hold several runs (a multi-turn conversation); print each on its own.
  const byRun = new Map<string, TraceEvent[]>();
  for (const e of events) byRun.set(e.runId, [...(byRun.get(e.runId) ?? []), e]);
  console.log(`# ${file}`);
  for (const run of byRun.values()) console.log(formatTrace(run) + "\n");
}
if (files.length > 1 || all.length) console.log(formatStats(summarizeEvents(all)).join("\n"));
