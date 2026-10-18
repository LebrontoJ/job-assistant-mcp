import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createInterface } from "node:readline/promises";
import { createLLM } from "./llm/index.js";
import { runAgent } from "./loop.js";
import type { Message } from "./llm/types.js";

async function main() {
  try {
    process.loadEnvFile(".env");
  } catch {
    // no .env: rely on the real environment
  }
  const llm = createLLM();
  const mcp = new Client({ name: "job-assistant-cli", version: "0.1.0" });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/server/index.ts"],
      env: { ...(process.env as Record<string, string>) },
      stderr: "inherit",
    }),
  );

  const oneShot = process.argv.slice(2).join(" ").trim();
  let history: Message[] = [];
  const ask = async (text: string) => {
    const run = await runAgent(llm, mcp, text, { history });
    history = run.messages;
    for (const t of run.trace) console.error(`  [tool] ${t.name}(${JSON.stringify(t.args)})${t.isError ? " -> error" : ""}`);
    console.log(run.answer || `(no answer: ${run.stoppedBecause})`);
  };

  console.error(`provider=${llm.provider} model=${llm.model}`);
  if (oneShot) {
    await ask(oneShot);
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    for (;;) {
      const line = (await rl.question("> ")).trim();
      if (!line || line === "exit") break;
      await ask(line);
    }
    rl.close();
  }
  await mcp.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
