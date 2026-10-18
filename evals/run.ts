import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CachingLLM } from "../src/agent/llm/cache.js";
import { createLLM } from "../src/agent/llm/index.js";
import { createEmbedding } from "../src/rag/factory.js";
import { ProfileIndex, type SearchMode } from "../src/rag/index.js";
import { createEnv } from "./env.js";
import { createJudge } from "./judge.js";
import { loadCases, loadRetrievalCases } from "./load.js";
import { formatReport, summarize, type RetrievalReport } from "./report.js";
import { diffRanks, evalRetrieval } from "./retrieval.js";
import { runEval } from "./runner.js";

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
  const runs = Object.fromEntries(
    await Promise.all(modes.map(async (m) => [m, await evalRetrieval(retrievalCases, index, { mode: m })] as const)),
  );
  const retrieval: RetrievalReport = {
    modes: Object.fromEntries(modes.map((m) => [m, runs[m]!.summary])),
    changes: Object.fromEntries(modes.filter((m) => m !== "bm25").map((m) => [m, diffRanks(runs.bm25!.results, runs[m]!.results)])),
    embedder: embedding.embedder?.id,
  };

  if (flags.has("retrieval-only")) {
    console.log(formatReport({ provider: "-", model: "-", date: stamp }, [], retrieval));
    return;
  }

  const base = createLLM({ provider: values.provider, model: values.model });
  const llm = flags.has("no-cache") ? base : new CachingLLM(base, ".cache/llm");
  const judgeProvider = values["judge-provider"] ?? process.env.JUDGE_PROVIDER;
  const judgeLLM = flags.has("judge")
    ? createLLM({
        provider: judgeProvider ?? values.provider,
        // An explicitly different judge provider must not inherit the agent's model id.
        model: values["judge-model"] ?? process.env.JUDGE_MODEL ?? (judgeProvider ? undefined : values.model),
      })
    : undefined;
  const judge = judgeLLM ? createJudge(flags.has("no-cache") ? judgeLLM : new CachingLLM(judgeLLM, ".cache/judge")) : undefined;

  const filter = values.filter?.toLowerCase();
  const cases = (await loadCases()).filter((c) => !filter || c.id.includes(filter) || c.category.includes(filter));
  if (!cases.length) throw new Error(`No cases match --filter ${values.filter}`);
  console.error(`Running ${cases.length} case(s) on ${llm.provider}/${llm.model}${judge ? " with judge" : ""}`);

  const results = await runEval(cases, {
    llm,
    makeEnv: () => createEnv({ index }),
    judge,
    concurrency: values.concurrency ? Number(values.concurrency) : 2,
    maxSteps: values["max-steps"] ? Number(values["max-steps"]) : 8,
    onResult: (r, done, total) =>
      console.error(`[${done}/${total}] ${r.passed ? "PASS" : "FAIL"} ${r.id}${r.error ? ` (error: ${r.error.slice(0, 80)})` : ""}`),
  });

  const meta = {
    provider: llm.provider,
    model: llm.model,
    judge: judgeLLM ? `${judgeLLM.provider}/${judgeLLM.model}` : undefined,
    cache: llm instanceof CachingLLM ? { hits: llm.hits, misses: llm.misses } : undefined,
    date: stamp,
  };
  console.log(formatReport(meta, results, retrieval));

  await mkdir("evals/results", { recursive: true });
  const name = `${stamp.replace(/[:.]/g, "-")}__${llm.provider}__${llm.model}`;
  await writeFile(
    join("evals/results", `${name}.json`),
    JSON.stringify({ meta, summary: summarize(results), retrieval, results }, null, 2),
  );
  console.error(`Saved evals/results/${name}.json`);
  if (results.some((r) => r.error)) process.exitCode = 2;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
