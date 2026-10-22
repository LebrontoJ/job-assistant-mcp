import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { JsonlTracer, contextualTracer, traceStage } from "../agent/trace.js";
import { resolve } from "node:path";
import { tracedEmbedder } from "../rag/traced-embedder.js";
import { createEmbedding } from "../rag/factory.js";
import { ProfileIndex } from "../rag/index.js";
import { ApplicationStore } from "../store/applications.js";
import { createServer } from "./server.js";

const file = resolve(process.env.APPLICATIONS_FILE ?? "data/sample/applications.json");
const profileDir = resolve(process.env.PROFILE_DIR ?? "data/sample/profile");
const embedding = createEmbedding();
const startupId = randomUUID();
const tracer = contextualTracer(process.env.TRACE_DIR ? new JsonlTracer(resolve(process.env.TRACE_DIR, `startup-${startupId}.jsonl`)) : undefined, startupId);
const profile = await traceStage(tracer, startupId, "profile.index", () => ProfileIndex.fromDir(profileDir, tracedEmbedder(embedding.embedder, tracer, startupId), { minSimilarity: embedding.minSimilarity }));
const server = createServer(new ApplicationStore(file), profile, { match: { semantic: embedding.matchSemantic } });

// stdout carries the MCP protocol; anything human-readable must go to stderr.
await server.connect(new StdioServerTransport());
console.error(`job-assistant MCP server ready (applications: ${file}, profile: ${profileDir}, ${profile.size} chunks, ${profile.hybrid ? "hybrid" : "bm25"} retrieval)`);
