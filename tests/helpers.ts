import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileIndex } from "../src/rag/index.js";
import { createServer } from "../src/server/server.js";
import { ApplicationStore } from "../src/store/applications.js";

/** A real MCP server + client wired in memory, on a throwaway copy of the sample data. */
export async function connectedPair(now = new Date("2026-10-16T12:00:00Z")) {
  const dir = await mkdtemp(join(tmpdir(), "ja-mcp-"));
  const file = join(dir, "apps.json");
  await copyFile("data/sample/applications.json", file);
  const store = new ApplicationStore(file, () => now);
  const profile = await ProfileIndex.fromDir("data/sample/profile");
  const server = createServer(store, profile);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, store };
}

export const textOf = (r: unknown) =>
  (((r as { content?: unknown }).content ?? []) as Array<{ text?: string }>).map((c) => c.text ?? "").join("");
