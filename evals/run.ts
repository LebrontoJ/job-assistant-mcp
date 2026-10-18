import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CachingLLM } from "../src/agent/llm/cache.js";
import { createLLM } from "../src/agent/llm/index.js";
import { ProfileIndex } from "../src/rag/index.js";
import { createJudge } from "./judge.js";
import { loadCases, loadRetrievalCases } from "./load.js";
import { formatReport, summarize } from "./report.js";
import { evalRetrieval } from "./retrieval.js";
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

  const index = await ProfileIndex.fromDir(process.env.PROFILE_DIR ?? "data/sample/profile");
  const retrieval = await evalRetrieval(await loadRetrievalCases(), index);

  if (flags.has("retrieval-only")) {
    console.log(formatReport({ provider: "-", model: "-", date: stamp }, [], retrieval.summary));
    return;
  }

  const base = createLLM({ provider: values.provider, model: values.model });
  const llm = flags.has("no-cache") ? base : new CachingLLM(base, ".cache/llm");
  const judgeLLM = flags.has("judge")
    ? createLLM({ provider: values["judge-provider"] ?? values.provider, model: values["judge-model"] ?? values.model })
    : undefined;
  const judge = judgeLLM ? createJudge(flags.has("no-cache") ? judgeLLM : new CachingLLM(judgeLLM, ".cache/judge")) : undefined;

  const filter = values.filter?.toLowerCase();
  const cases = (await loadCases()).filter((c) => !filter || c.id.includes(filter) || c.category.includes(filter));
  if (!cases.length) throw new Error(`No cases match --filter ${values.filter}`);
  console.error(`Running ${cases.length} case(s) on ${llm.provider}/${llm.model}${judge ? " with judge" : ""}`);

  const results = await runEval(cases, {
    llm,
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
  console.log(formatReport(meta, results, retrieval.summary));

  await mkdir("evals/results", { recursive: true });
  const name = `${stamp.replace(/[:.]/g, "-")}__${llm.provider}__${llm.model}`;
  await writeFile(
    join("evals/results", `${name}.json`),
    JSON.stringify({ meta, summary: summarize(results), retrieval: retrieval.summary, results }, null, 2),
  );
  console.error(`Saved evals/results/${name}.json`);
  if (results.some((r) => r.error)) process.exitCode = 2;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
