import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { LLMClient, Message, ToolResult, ToolSpec, Usage } from "./llm/types.js";

export interface ToolTrace {
  name: string;
  args: Record<string, unknown>;
  result: string;
  isError: boolean;
}

export interface AgentRun {
  answer: string;
  messages: Message[];
  trace: ToolTrace[];
  usage: Usage;
  steps: number;
  stoppedBecause: "answered" | "max_steps" | "blocked" | "truncated";
}

export const SYSTEM_PROMPT = `You are a job-search assistant. You can read and update the user's application tracker and analyse job descriptions through tools.

- Use tools to get facts; never invent applications, dates or ids. If you need an id, look it up first.
- Tools that write data return a preview until confirm=true is passed. Show the preview to the user and ask. Only pass confirm=true after the user has clearly said yes in this conversation.
- Never fabricate experience, skills or achievements for the user. If something is not in the data you were given, say so.
- Keep answers short and concrete.`;

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

  for (let step = 1; step <= maxSteps; step++) {
    const res = await llm.chat({ system, messages, tools });
    usage.inputTokens += res.usage.inputTokens;
    usage.outputTokens += res.usage.outputTokens;
    messages.push({ role: "assistant", text: res.text, toolCalls: res.toolCalls, raw: res.raw });

    if (res.toolCalls.length === 0) {
      const stoppedBecause =
        res.finish === "blocked" ? "blocked" : res.finish === "length" ? "truncated" : "answered";
      return { answer: res.text, messages, trace, usage, steps: step, stoppedBecause };
    }

    // Independent calls from one turn run concurrently; results go back in a single message.
    const results: ToolResult[] = await Promise.all(
      res.toolCalls.map(async (call): Promise<ToolResult> => {
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

  return {
    answer: "",
    messages,
    trace,
    usage,
    steps: maxSteps,
    stoppedBecause: "max_steps",
  };
}
