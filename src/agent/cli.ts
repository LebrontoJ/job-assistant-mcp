import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { modelVerifier } from "./grounding.js";
import { ExecutionBudget } from "./execution.js";
import { createLLM } from "./llm/index.js";
import { runAgent } from "./loop.js";
import { JsonlTracer, contextualTracer, traceStage } from "./trace.js";
import type { Message } from "./llm/types.js";

const shorten = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n)}… (${s.length} chars)` : s);

async function main() {
  try {
    process.loadEnvFile(".env");
  } catch {
    // no .env: rely on the real environment
  }
  const llm = createLLM();
  // TRACE_DIR=.traces writes one JSONL trace per CLI session; view it with `pnpm trace <file>`.
  const tracer = process.env.TRACE_DIR
    ? new JsonlTracer(`${process.env.TRACE_DIR}/cli-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`)
    : undefined;
  const sessionId = randomUUID();
  let turn = 0;
  const mcp = new Client({ name: "job-assistant-cli", version: "0.1.0" });
  try {
  await traceStage(contextualTracer(tracer, sessionId), sessionId, "mcp.connect", () => new ExecutionBudget(20_000).run("mcp.connect", 15_000, signal => mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/server/index.ts"],
      env: { ...(process.env as Record<string, string>) },
      stderr: "inherit",
    }),
    { signal, timeout: 15_000 },
  )));

  const oneShot = process.argv.slice(2).join(" ").trim();
  let history: Message[] = [];
  const ask = async (text: string) => {
    const run = await runAgent(llm, mcp, text, { history, tracer, groundingVerifier: modelVerifier(llm), taskId: sessionId, runId: `${sessionId}-t${++turn}` });
    history = run.messages;
    for (const t of run.trace) console.error(`  [tool] ${t.name}(${shorten(JSON.stringify(t.args))})${t.isError ? " -> error" : ""}`);
    console.log(run.answer || `(no answer: ${run.stoppedBecause})`);
  };

  console.error(`provider=${llm.provider} model=${llm.model}`);
  if (oneShot) {
    await ask(oneShot);
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
    for (;;) {
      const line = (await rl.question("> ")).trim();
      if (!line || line === "exit") break;
      await ask(line);
    }
    } finally { rl.close(); }
  }
  } finally { await mcp.close(); }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
