// Provider-neutral shapes. Adapters translate to/from each vendor's wire format, so the
// agent loop and the eval harness never see vendor types.

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments, as returned by MCP tools/list. */
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  name: string;
  text: string;
  isError?: boolean;
}

export type Message =
  /** `synthetic` marks text the host injected (e.g. a citation reminder); it is never a human reply. */
  | { role: "user"; text: string; synthetic?: boolean }
  /** `raw` is the vendor's own message, replayed verbatim (e.g. Gemini thought signatures). */
  | { role: "assistant"; text: string; toolCalls: ToolCall[]; raw?: unknown }
  | { role: "tool"; results: ToolResult[] };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  /** Why generation stopped, normalised: a refusal or truncation should not look like success. */
  finish: "stop" | "tool_calls" | "length" | "blocked" | "other";
  raw?: unknown;
}

export interface LLMClient {
  readonly provider: string;
  readonly model: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}
