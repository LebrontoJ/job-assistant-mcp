import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve } from "node:path";
import { ApplicationStore } from "../store/applications.js";
import { createServer } from "./server.js";

const file = resolve(process.env.APPLICATIONS_FILE ?? "data/sample/applications.json");
const server = createServer(new ApplicationStore(file));

// stdout carries the MCP protocol; anything human-readable must go to stderr.
await server.connect(new StdioServerTransport());
console.error(`job-assistant MCP server ready (applications: ${file})`);
