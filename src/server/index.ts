import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve } from "node:path";
import { createEmbedding } from "../rag/factory.js";
import { ProfileIndex } from "../rag/index.js";
import { ApplicationStore } from "../store/applications.js";
import { createServer } from "./server.js";

const file = resolve(process.env.APPLICATIONS_FILE ?? "data/sample/applications.json");
const profileDir = resolve(process.env.PROFILE_DIR ?? "data/sample/profile");
const embedding = createEmbedding();
const profile = await ProfileIndex.fromDir(profileDir, embedding.embedder, { minSimilarity: embedding.minSimilarity });
const server = createServer(new ApplicationStore(file), profile);

// stdout carries the MCP protocol; anything human-readable must go to stderr.
await server.connect(new StdioServerTransport());
console.error(`job-assistant MCP server ready (applications: ${file}, profile: ${profileDir}, ${profile.size} chunks, ${profile.hybrid ? "hybrid" : "bm25"} retrieval)`);
