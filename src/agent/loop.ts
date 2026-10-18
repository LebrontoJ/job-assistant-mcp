import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { citationProblem } from "./citations.js";
import { BLOCKED_MESSAGE, checkWriteGate } from "./gate.js";
import type { LLMClient, Message, ToolResult, ToolSpec, Usage } from "./llm/types.js";

export interface ToolTrace {
  name: string;
  args: Record<string, unknown>;
  result: string;
  isError: boolean;
  /** The host refused to run it (write gate). Still recorded: it shows what the model tried. */
  blocked?: boolean;
}

export interface AgentRun {
  answer: string;
  messages: Message[];
  trace: ToolTrace[];
  usage: Usage;
  steps: number;
  stoppedBecause: "answered" | "max_steps" | "blocked" | "truncated";
  /** Confirmed writes the host refused because no preview/user reply preceded them. */
  blockedWrites: number;
  /** Times the host sent the model back to fix its citations. */
  citationRetries: number;
}

export const SYSTEM_PROMPT = `You are a job-search assistant. You can read and update the user's application tracker, analyse job descriptions, and search the user's own profile documents through tools.

Grounding
- Use tools to get facts; never invent applications, dates or ids. If you need an id, look it up first.
- Everything you say about the user's experience must come from search_profile or match_resume results. Cite the passage id in brackets, e.g. [resume.md#0]. If the profile has no evidence for something, say so plainly instead of filling the gap.
- When asked for resume bullets or a cover letter, retrieve evidence first, then write only claims those passages support. Keep numbers and facts exactly as written there.
- search_profile can return passages that are only topically related. Use a passage only if its text actually states the fact; a related passage is not evidence for a specific skill, tool or number.
- match_resume is a word-overlap signal: "no_evidence" means "not found in the profile", and numeric requirements such as years of experience need your own check against the dates in the profile.

Writing data
- Tools that write return a preview until confirm=true is passed. Show the preview to the user and ask. Only pass confirm=true after the user has clearly said yes in this conversation.

Style: short and concrete.`;

export async function listToolSpecs(mcp: Client): Promise<ToolSpec[]> {
  const { tools } = await mcp.listTools();
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema as Record<string, unknown>,
  }));
}

export interface RunOptions {
  maxSteps?: number;
  system?: string;
  /** Prior turns, for multi-turn chat. */
  history?: Message[];
  /** Enforce preview-then-user-reply before confirmed writes. Default true. */
  writeGate?: boolean;
  /** Send the model back once when its answer cites nothing or cites unknown ids. Default true. */
  citationGuard?: boolean;
}

export async function runAgent(
  llm: LLMClient,
  mcp: Client,
  userText: string,
  opts: RunOptions = {},
): Promise<AgentRun> {
  const { maxSteps = 8, system = SYSTEM_PROMPT } = opts;
  const tools = await listToolSpecs(mcp);
  const messages: Message[] = [...(opts.history ?? []), { role: "user", text: userText }];
  const trace: ToolTrace[] = [];
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };

  let blockedWrites = 0;
  let citationRetries = 0;
  const finish = (answer: string, steps: number, stoppedBecause: AgentRun["stoppedBecause"]): AgentRun => ({
    answer, messages, trace, usage, steps, stoppedBecause, blockedWrites, citationRetries,
  });

  for (let step = 1; step <= maxSteps; step++) {
    const res = await llm.chat({ system, messages, tools });
    usage.inputTokens += res.usage.inputTokens;
    usage.outputTokens += res.usage.outputTokens;
    messages.push({ role: "assistant", text: res.text, toolCalls: res.toolCalls, raw: res.raw });

    if (res.toolCalls.length === 0) {
      const stop = res.finish === "blocked" ? "blocked" : res.finish === "length" ? "truncated" : "answered";
      if (stop === "answered" && opts.citationGuard !== false && citationRetries < 1 && step < maxSteps) {
        const problem = citationProblem(res.text, messages, trace);
        if (problem) {
          citationRetries++;
          messages.push({ role: "user", text: problem, synthetic: true });
          continue;
        }
      }
      return finish(res.text, step, stop);
    }

    // Independent calls from one turn run concurrently; results go back in a single message.
    const results: ToolResult[] = await Promise.all(
      res.toolCalls.map(async (call): Promise<ToolResult> => {
        if (opts.writeGate !== false) {
          const decision = checkWriteGate(messages, call);
          if (!decision.allowed) {
            blockedWrites++;
            trace.push({ name: call.name, args: call.args, result: BLOCKED_MESSAGE, isError: true, blocked: true });
            return { callId: call.id, name: call.name, text: BLOCKED_MESSAGE, isError: true };
          }
        }
        try {
          const out = await mcp.callTool({ name: call.name, arguments: call.args });
          const content = (out.content ?? []) as Array<{ type: string; text?: string }>;
          const text = content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
          const isError = out.isError === true;
          trace.push({ name: call.name, args: call.args, result: text, isError });
          return { callId: call.id, name: call.name, text, isError };
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          trace.push({ name: call.name, args: call.args, result: text, isError: true });
          return { callId: call.id, name: call.name, text, isError: true };
        }
      }),
    );
    messages.push({ role: "tool", results });
  }

  return finish("", maxSteps, "max_steps");
}
