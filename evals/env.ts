import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileIndex } from "../src/rag/index.js";
import { createServer } from "../src/server/server.js";
import { ApplicationStore } from "../src/store/applications.js";

/** Fixed "today" so follow-up windows mean the same thing on every run. */
export const EVAL_NOW = new Date("2026-10-16T12:00:00Z");

export interface EvalEnv {
  client: Client;
  store: ApplicationStore;
  index: ProfileIndex;
  close(): Promise<void>;
}

/** A fresh MCP server + client over a throwaway copy of the sample data, so cases cannot affect each other. */
export async function createEnv(
  opts: { now?: Date; profileDir?: string; applications?: string; index?: ProfileIndex } = {},
): Promise<EvalEnv> {
  const dir = await mkdtemp(join(tmpdir(), "ja-eval-"));
  const file = join(dir, "applications.json");
  await copyFile(opts.applications ?? "data/sample/applications.json", file);
  const store = new ApplicationStore(file, () => opts.now ?? EVAL_NOW);
  const index = opts.index ?? (await ProfileIndex.fromDir(opts.profileDir ?? "data/sample/profile"));
  const server = createServer(store, index);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "eval", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    client,
    store,
    index,
    close: async () => {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
