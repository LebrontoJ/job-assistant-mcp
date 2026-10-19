import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CachingLLM } from "../src/agent/llm/cache.js";
import { RateLimitedLLM } from "../src/agent/llm/ratelimit.js";
import type { LLMClient } from "../src/agent/llm/types.js";
import { createLLM } from "../src/agent/llm/index.js";
import { createEmbedding } from "../src/rag/factory.js";
import { ProfileIndex, type SearchMode } from "../src/rag/index.js";
import { createEnv } from "./env.js";
import { createJudge } from "./judge.js";
import { loadCases, loadMatchCases, loadRetrievalCases } from "./load.js";
import { bySplit, collectSignals, formatMatching, formatMisses, score, sweep } from "./matching.js";
import { formatReport, stability, summarize, type RetrievalReport } from "./report.js";
import { diffRanks, evalRetrieval } from "./retrieval.js";
import { runEval, type CaseResult } from "./runner.js";

function parseArgs(argv: string[]) {
  const flags = new Set<string>();
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      values[key] = next;
      i++;
    } else flags.add(key);
  }
  return { flags, values };
}

async function main() {
  try {
    process.loadEnvFile(".env");
  } catch {
    // no .env
  }
  const { flags, values } = parseArgs(process.argv.slice(2));
  const stamp = new Date().toISOString();

  const embedding = createEmbedding({ ...process.env, ...(values.embeddings ? { EMBEDDINGS: values.embeddings } : {}) });
  const index = await ProfileIndex.fromDir(process.env.PROFILE_DIR ?? "data/sample/profile", embedding.embedder, {
    minSimilarity: embedding.minSimilarity,
  });
  const retrievalCases = await loadRetrievalCases();
  const modes: SearchMode[] = embedding.embedder ? ["bm25", "dense", "hybrid"] : ["bm25"];
  const retrievalRuns = Object.fromEntries(
    await Promise.all(modes.map(async (m) => [m, await evalRetrieval(retrievalCases, index, { mode: m })] as const)),
  );
  const retrieval: RetrievalReport = {
    modes: Object.fromEntries(modes.map((m) => [m, retrievalRuns[m]!.summary])),
    changes: Object.fromEntries(modes.filter((m) => m !== "bm25").map((m) => [m, diffRanks(retrievalRuns.bm25!.results, retrievalRuns[m]!.results)])),
    embedder: embedding.embedder?.id,
  };

  if (flags.has("match-only")) {
    // Requirement-matching quality: word overlap alone vs word overlap plus embedding similarity.
    const cases = await loadMatchCases();
    const lexicalIndex = await ProfileIndex.fromDir(process.env.PROFILE_DIR ?? "data/sample/profile");
    const lexical = score(await collectSignals(cases, lexicalIndex));
    const rows = [{ label: "keyword only", scored: lexical }];
    const names = new Map(cases.map((c) => [c.id, c.item]));
    const extra: string[] = [...formatMisses("keyword only", lexical, names)];
    if (embedding.embedder) {
      const signals = await collectSignals(cases, index);
      if (flags.has("sweep")) {
        const ranked = sweep(signals)
          .filter((r) => r.dev.falseSupported === 0)
          .sort((a, b) => b.dev.accuracy - a.dev.accuracy || a.dev.overreach - b.dev.overreach || b.dev.surfaced.found - a.dev.surfaced.found);
        console.log("## Threshold sweep (dev split only; rows with 0 false `supported`)\n");
        console.log("| high | low | dev exact | overreach | evidence shown for supported | labelled supported |\n|---|---|---|---|---|---|");
        for (const r of ranked.slice(0, 25)) {
          console.log(`| ${r.high} | ${r.low} | ${(100 * r.dev.accuracy).toFixed(0)}% | ${r.dev.overreach} | ${r.dev.surfaced.found}/${r.dev.surfaced.total} | ${r.dev.recognised.found}/${r.dev.recognised.total} |`);
        }
        console.log(`\n${ranked.length} of the grid's settings had no false 'supported' on dev.\n`);
      }
      const high = Number(values["match-high"] ?? embedding.matchSemantic?.high);
      const low = Number(values["match-low"] ?? embedding.matchSemantic?.low);
      if (Number.isFinite(high) && Number.isFinite(low)) {
        const semantic = score(signals, { high, low });
        rows.push({ label: `with embeddings (high ${high}, low ${low})`, scored: semantic });
        extra.push(...formatMisses(`with embeddings (high ${high}, low ${low})`, semantic, names));
      } else {
        console.error("No thresholds: pass --match-high and --match-low (or run with --sweep to choose them on dev).");
      }
    }
    console.log(formatMatching(rows).join("\n"));
    console.log(extra.join("\n"));
    return;
  }

  if (flags.has("retrieval-only")) {
    console.log(formatReport({ provider: "-", model: "-", date: stamp }, [], retrieval));
    return;
  }

  const rpm = values.rpm ? Number(values.rpm) : undefined;
  const live = (c: LLMClient) => (rpm ? new RateLimitedLLM(c, rpm) : c);
  const useCache = !flags.has("no-cache");
  const base = live(createLLM({ provider: values.provider, model: values.model }));
  const judgeProvider = values["judge-provider"] ?? process.env.JUDGE_PROVIDER;
  const judgeBase = flags.has("judge")
    ? live(
        createLLM({
          provider: judgeProvider ?? values.provider,
          // An explicitly different judge provider must not inherit the agent's model id.
          model: values["judge-model"] ?? process.env.JUDGE_MODEL ?? (judgeProvider ? undefined : values.model),
        }),
      )
    : undefined;
  const judgeLLM = judgeBase && useCache ? new CachingLLM(judgeBase, ".cache/judge") : judgeBase;
  const judge = judgeLLM ? createJudge(judgeLLM) : undefined;

  const filter = values.filter?.toLowerCase();
  const suite = values.suite ?? "all";
  if (!["all", "core", "extended"].includes(suite)) throw new Error(`--suite must be core, extended or all, got "${suite}"`);
  const cases = (await loadCases()).filter(
    (c) => (suite === "all" || c.suite === suite) && (!filter || c.id.includes(filter) || c.category.includes(filter)),
  );
  if (!cases.length) throw new Error("No cases match the given --suite/--filter");
  const repeat = Math.max(1, Number(values.repeat ?? 1));
  console.error(`Running ${cases.length} case(s) x${repeat} on ${base.provider}/${base.model}${judge ? ` with judge ${judgeLLM!.model}` : ""}`);

  // Run i uses cache salt i: run 0 replays earlier recordings, later runs record fresh independent samples.
  const llms = Array.from({ length: repeat }, (_, i) => (useCache ? new CachingLLM(base, ".cache/llm", i) : base));
  const runs: CaseResult[][] = [];
  for (const [i, llm] of llms.entries()) {
    runs.push(
      await runEval(cases, {
        llm,
        judge,
        makeEnv: (c) =>
          createEnv({ applications: c.fixture?.applications, ...(c.fixture?.profile ? { profileDir: c.fixture.profile } : { index }) }),
        traceDir: values["trace-dir"] ? join(values["trace-dir"], `run${i + 1}`) : undefined,
        concurrency: values.concurrency ? Number(values.concurrency) : 1,
        maxSteps: values["max-steps"] ? Number(values["max-steps"]) : 8,
        onResult: (r, done, total) =>
          console.error(`[run ${i + 1}/${repeat}] [${done}/${total}] ${r.passed ? "PASS" : "FAIL"} ${r.id}${r.error ? ` (error: ${r.error.slice(0, 80)})` : ""}`),
      }),
    );
  }
  const results = runs.flat();
  const cacheStats = llms.filter((l): l is CachingLLM => l instanceof CachingLLM);

  const meta = {
    provider: base.provider,
    model: base.model,
    judge: judgeLLM ? `${judgeLLM.provider}/${judgeLLM.model}` : undefined,
    repeat,
    cache: cacheStats.length ? { hits: cacheStats.reduce((a, l) => a + l.hits, 0), misses: cacheStats.reduce((a, l) => a + l.misses, 0) } : undefined,
    date: stamp,
  };
  console.log(formatReport(meta, results, retrieval, runs));

  await mkdir("evals/results", { recursive: true });
  const name = `${stamp.replace(/[:.]/g, "-")}__${base.provider}__${base.model}`;
  await writeFile(
    join("evals/results", `${name}.json`),
    JSON.stringify({ meta, summary: summarize(results), stability: repeat > 1 ? stability(runs) : undefined, retrieval, results, runs: repeat > 1 ? runs : undefined }, null, 2),
  );
  console.error(`Saved evals/results/${name}.json`);
  if (results.some((r) => r.error)) process.exitCode = 2;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
