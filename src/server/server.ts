import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ApplicationStore, StatusSchema } from "../store/applications.js";
import { parseJd } from "./jd.js";

const json = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});

const fail = (message: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: message }],
});

const PENDING_HINT =
  "Nothing was written. Show the user this preview, and only call the tool again with confirm=true after they explicitly agree.";

const confirmField = z
  .boolean()
  .optional()
  .describe("Must be true to actually write. Set it only after the user has explicitly approved the change.");

export function createServer(store: ApplicationStore): McpServer {
  const server = new McpServer({ name: "job-assistant", version: "0.1.0" });

  server.registerTool(
    "parse_jd",
    {
      title: "Parse job description",
      description:
        "Split a pasted job description into structured fields: title, company, location, work mode, " +
        "minimum years of experience, responsibilities, requirements, nice-to-haves and recognised skills. " +
        "Deterministic and read-only; it does not judge fit.",
      inputSchema: { text: z.string().min(20).describe("The full job description text.") },
    },
    async ({ text }) => json(parseJd(text)),
  );

  server.registerTool(
    "list_applications",
    {
      title: "List applications",
      description: "List tracked job applications, optionally filtered by status or company name substring.",
      inputSchema: {
        status: StatusSchema.optional().describe("Only return applications in this status."),
        company: z.string().optional().describe("Case-insensitive company name substring."),
      },
    },
    async (filter) => json(await store.list(filter)),
  );

  server.registerTool(
    "list_followups",
    {
      title: "List follow-ups due",
      description:
        "List open applications (not offer/rejected/withdrawn) whose follow-up date is overdue or due within the next N days.",
      inputSchema: {
        days: z.number().int().min(0).max(90).optional().describe("Look-ahead window in days. Default 7."),
      },
    },
    async ({ days }) => json(await store.followups(days ?? 7)),
  );

  server.registerTool(
    "add_application",
    {
      title: "Add application",
      description:
        "Add a job to the application tracker. This writes data: without confirm=true it only returns a preview.",
      inputSchema: {
        company: z.string().min(1),
        role: z.string().min(1).describe("Job title."),
        status: StatusSchema.optional().describe("Defaults to wishlist."),
        url: z.string().optional(),
        appliedDate: z.string().optional().describe("YYYY-MM-DD."),
        nextFollowUp: z.string().optional().describe("YYYY-MM-DD."),
        notes: z.string().optional(),
        confirm: confirmField,
      },
    },
    async ({ confirm, ...input }) => {
      const duplicate = await store.findDuplicate(input.company, input.role);
      if (duplicate) {
        return json({ status: "duplicate", existing: duplicate, hint: "Use update_application instead." });
      }
      if (!confirm) return json({ status: "pending_confirmation", preview: input, hint: PENDING_HINT });
      return json({ status: "created", application: await store.add(input) });
    },
  );

  server.registerTool(
    "update_application",
    {
      title: "Update application",
      description:
        "Change status, follow-up date or notes of an existing application by id. This writes data: " +
        "without confirm=true it only returns a preview.",
      inputSchema: {
        id: z.string().describe("Application id from list_applications."),
        status: StatusSchema.optional(),
        nextFollowUp: z.string().optional().describe("YYYY-MM-DD."),
        notes: z.string().optional(),
        confirm: confirmField,
      },
    },
    async ({ id, confirm, ...patch }) => {
      const current = await store.get(id);
      if (!current) return fail(`No application with id "${id}". Call list_applications to find the right id.`);
      if (!confirm) {
        return json({ status: "pending_confirmation", current, changes: patch, hint: PENDING_HINT });
      }
      return json({ status: "updated", application: await store.update(id, patch) });
    },
  );

  return server;
}
