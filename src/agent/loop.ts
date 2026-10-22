import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ExecutionBudget, ToolExecutor, boundedLLM, type ExecutionOptions } from "./execution.js";
import { answerGroundingProblem, type SemanticVerifier } from "./grounding.js";
import { citationProblem } from "./citations.js";
import { BLOCKED_MESSAGE, checkWriteGate } from "./gate.js";
import { clip, contextualTracer, traceStage, tracedExecution, type Tracer } from "./trace.js";
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
  execution?: ExecutionOptions;
  totalMs?: number;
  signal?: AbortSignal;
  maxSteps?: number;
  system?: string;
  /** Prior turns, for multi-turn chat. */
  history?: Message[];
  /** Enforce preview-then-user-reply before confirmed writes. Default true. */
  writeGate?: boolean;
  /** Send the model back once when its answer cites nothing or cites unknown ids. Default true. */
  citationGuard?: boolean;
  /** Receives one event per model call, tool call, guard action and run boundary. */
  approval?: { operationId: string; decision: "approve" | "cancel" };
  groundingVerifier?: SemanticVerifier;
  tracer?: Tracer;
  /** Identifies this run in trace events. Defaults to a random id. */
  taskId?: string;
  runId?: string;
}

export async function runAgent(
  llm: LLMClient,
  mcp: Client,
  userText: string,
  opts: RunOptions = {},
): Promise<AgentRun> {
  const { maxSteps = 8, system = SYSTEM_PROMPT } = opts;
  const budget = opts.execution?.budget ?? new ExecutionBudget(opts.totalMs, opts.signal);
  llm = boundedLLM(llm, budget);
  const runId = opts.runId ?? Math.random().toString(36).slice(2, 10);
  const tracer = contextualTracer(opts.tracer, opts.taskId ?? runId);
  const executor = new ToolExecutor(mcp, { ...tracedExecution(opts.execution, tracer, runId), budget });
  const startedAt = Date.now();
  const now = () => new Date().toISOString();
  let tools: ToolSpec[];
  const messages: Message[] = [...(opts.history ?? []), { role: "user", text: userText, ...(opts.approval ? { approval: opts.approval } : {}) }];
  const trace: ToolTrace[] = [];
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  tracer?.emit({ type: "run_start", runId, ts: now(), provider: llm.provider, model: llm.model, user: clip(userText, 200) });

  let blockedWrites = 0;
  let citationRetries = 0;
  const finish = (answer: string, steps: number, stoppedBecause: AgentRun["stoppedBecause"] | "error"): AgentRun => {
    tracer?.emit({
      type: "run_end", runId, ts: now(), ms: Date.now() - startedAt, steps, stoppedBecause,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, answerChars: answer.length,
    });
    return { answer, messages, trace, usage, steps, stoppedBecause: stoppedBecause as AgentRun["stoppedBecause"], blockedWrites, citationRetries };
  };

  let step = 1;
  try {
    tools = await traceStage(tracer, runId, "tools/list", () => budget.run("tools/list", 15_000, signal => mcp.listTools({}, { signal, timeout: 15_000 }))).then(({ tools }) => tools.map(t => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema as Record<string, unknown> })));
    for (; step <= maxSteps; step++) {
      const res = await traceStage(tracer, runId, "llm.chat", () => llm.chat({ system, messages, tools }));
      usage.inputTokens += res.usage.inputTokens;
      usage.outputTokens += res.usage.outputTokens;
      messages.push({ role: "assistant", text: res.text, toolCalls: res.toolCalls, raw: res.raw });
      tracer?.emit({
        type: "llm_call", runId, ts: now(), step, ms: res.latencyMs, ...(res.retries ? { retries: res.retries } : {}),
        inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens,
        finish: res.finish, toolCalls: res.toolCalls.map((c) => c.name),
      });

      if (res.toolCalls.length === 0) {
        const stop = res.finish === "blocked" ? "blocked" : res.finish === "length" ? "truncated" : "answered";
        if (stop === "answered" && opts.citationGuard !== false) {
          const problem = citationProblem(res.text, messages, trace) ?? await traceStage(tracer, runId, 'grounding', () =>
            budget.run('grounding', 60_000, signal => {
              const verifier: SemanticVerifier | undefined = opts.groundingVerifier
                ? (claim, evidence) => opts.groundingVerifier!(claim, evidence, signal)
                : undefined;
              return answerGroundingProblem(res.text, userText, messages, verifier);
            }));
          if (problem) {
            if (citationRetries < 1 && step < maxSteps) {
              citationRetries++;
              tracer?.emit({ type: "guard", runId, ts: now(), step, kind: "citation_retry", detail: problem });
              messages.push({ role: "user", text: problem, synthetic: true });
              continue;
            }
            return finish("I could not verify this draft against the profile evidence. Unsupported content was withheld; please add evidence or narrow the request.", step, "blocked");
          }
        }
        return finish(res.text, step, stop);
      }

      // Independent calls from one turn run concurrently; results go back in a single message.
      const results: ToolResult[] = await Promise.all(
        res.toolCalls.map(async (call): Promise<ToolResult> => {
          const t0 = Date.now();
          const record = (result: string, isError: boolean, blocked?: boolean) => {
            trace.push({ name: call.name, args: call.args, result, isError, ...(blocked ? { blocked } : {}) });
            tracer?.emit({
              type: "tool_call", runId, ts: now(), step, toolCallId: call.id, operationId: call.args.operationId as string | undefined, name: call.name, args: clip(JSON.stringify(call.args), 300),
              ms: Date.now() - t0, isError, ...(blocked ? { blocked } : {}), result: clip(result, 300),
            });
          };
          if (opts.writeGate !== false) {
            const decision = checkWriteGate(messages, call);
            if (decision.operationId) call.args = { ...call.args, operationId: decision.operationId };
            if (!decision.allowed) {
              blockedWrites++;
              tracer?.emit({ type: "guard", runId, ts: now(), step, kind: "write_blocked", detail: `${call.name}: ${decision.reason}` });
              record(BLOCKED_MESSAGE, true, true);
              return { callId: call.id, name: call.name, text: BLOCKED_MESSAGE, isError: true };
            }
          }
          try {
            const out = await executor.call(call.name, call.args, call.id);
            const content = (out.content ?? []) as Array<{ type: string; text?: string }>;
            const text = content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
            const isError = out.isError === true;
            record(text, isError);
            return { callId: call.id, name: call.name, text, isError };
          } catch (err) {
            const text = err instanceof Error ? err.message : String(err);
            record(text, true);
            return { callId: call.id, name: call.name, text, isError: true };
          }
        }),
      );
      messages.push({ role: "tool", results });
    }
  } catch (err) {
    // A model/API failure still closes the trace, so a failed run is visible instead of just ending.
    finish("", step, "error");
    throw err;
  }

  return finish("", maxSteps, "max_steps");
}
