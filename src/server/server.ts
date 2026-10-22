import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ProfileIndex } from "../rag/index.js";
import { ApplicationStore, StatusSchema } from "../store/applications.js";
import { parseJd } from "./jd.js";
import { matchProfile, type MatchOptions } from "./match.js";

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

export function createServer(store: ApplicationStore, profile?: ProfileIndex, opts: { match?: MatchOptions } = {}): McpServer {
  const preview = async (tool: string, args: Record<string, unknown>, extra: Record<string, unknown>) => {
    const { operation, current } = await store.preparePreview(tool, args);
    return json({ status: "pending_confirmation", ...extra, ...(current ? { current } : {}), operation, hint: PENDING_HINT });
  };
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
        operationId: z.string().optional().describe("Operation id from the exact preview. Required for confirmed writes."),
      },
    },
    async ({ confirm, operationId, ...input }) => {
      if (confirm) {
        try { return json(await store.executeOperation(operationId ?? "", "add_application", input)); }
        catch (err) { return fail(String(err)); }
      }
      const duplicate = await store.findDuplicate(input.company, input.role);
      if (duplicate) {
        return json({ status: "duplicate", existing: duplicate, hint: "Use update_application instead." });
      }
      return preview("add_application", input, { preview: input });
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
        operationId: z.string().optional().describe("Operation id from the exact preview. Required for confirmed writes."),
      },
    },
    async ({ id, confirm, operationId, ...patch }) => {
      if (confirm) {
        try { return json(await store.executeOperation(operationId ?? "", "update_application", { id, ...patch })); }
        catch (err) { return fail(String(err)); }
      }
      try { return await preview("update_application", { id, ...patch }, { changes: patch }); }
      catch (err) { return fail(String(err)); }

    },
  );

  const noProfile = () =>
    fail("No profile documents are loaded. Add Markdown files to the profile directory (PROFILE_DIR) and restart.");

  server.registerTool(
    "search_profile",
    {
      title: "Search profile",
      description:
        "Search the user's own profile documents (resume, projects, STAR stories) and return the most relevant " +
        "passages with ids to cite. Use it before claiming anything about the user's experience. " +
        "If nothing relevant comes back, the profile does not contain it. Results retrieved by meaning alone " +
        "(keywordCoverage 0) are only topically close: read the passage and use it only if it actually states the fact.",
      inputSchema: {
        query: z.string().min(2).describe("What to look for, e.g. 'postgres performance' or 'led an incident'."),
        k: z.number().int().min(1).max(10).optional().describe("Number of passages. Default 5."),
      },
    },
    async ({ query, k }) => {
      if (!profile?.size) return noProfile();
      const hits = await profile.search(query, k ?? 5);
      return json({
        query,
        hits: hits.map((h) => ({
          id: h.chunk.id,
          source: h.chunk.source,
          heading: h.chunk.heading,
          text: h.chunk.text,
          score: Number(h.score.toFixed(3)),
          // Share of the query's words found in the passage; 0 means it was retrieved by meaning alone.
          keywordCoverage: Number(h.coverage.toFixed(2)),
          ...(h.similarity !== undefined ? { semanticSimilarity: Number(h.similarity.toFixed(3)) } : {}),
        })),
      });
    },
  );

  server.registerTool(
    "match_resume",
    {
      title: "Match profile to JD",
      description:
        "Compare a job description with the user's profile. For each requirement and nice-to-have it reports " +
        "whether the profile has supporting evidence (with chunk ids), and which JD skills appear or are missing. " +
        "Read-only; the result is a retrieval signal for you to interpret, not a final verdict. 'weak' means a related " +
        "passage exists, not that the requirement is met; requirements with a quantity (years) never exceed 'weak'.",
      inputSchema: { jd_text: z.string().min(20).describe("The full job description text.") },
    },
    async ({ jd_text }) => {
      if (!profile?.size) return noProfile();
      return json(await matchProfile(parseJd(jd_text), profile, opts.match));
    },
  );

  server.registerPrompt(
    "tailor-resume",
    {
      title: "Tailor resume to a job",
      description: "Analyse a JD against the user's profile and draft evidence-backed resume bullets.",
      argsSchema: { jd_text: z.string().describe("The full job description text.") },
    },
    ({ jd_text }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "Tailor my resume to this job. Steps: parse the JD, run match_resume, search_profile for the strongest " +
              "evidence behind each requirement, then write 3-5 resume bullets using only what those passages support, " +
              "each ending with its source id in brackets. Finish by listing requirements the profile does not cover.\n\n" +
              jd_text,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "weekly-review",
    {
      title: "Weekly job-search review",
      description: "Summarise pipeline status and what needs action this week.",
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "Review my job search. List applications by status, then list_followups for the next 7 days and tell me " +
              "what to do first. Do not change any data.",
          },
        },
      ],
    }),
  );

  return server;
}
