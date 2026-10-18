import { GoogleGenAI, type Content, type FunctionDeclaration, type Part } from "@google/genai";
import { withRetry } from "./retry.js";
import type { ChatRequest, ChatResponse, LLMClient, Message, ToolCall, ToolSpec } from "./types.js";

/** Keywords Gemini's function-declaration schema does not accept; MCP/zod emit them routinely. */
const UNSUPPORTED = new Set(["$schema", "additionalProperties", "$id", "$comment"]);

export function sanitizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (schema && typeof schema === "object") {
    return Object.fromEntries(
      Object.entries(schema as Record<string, unknown>)
        .filter(([k]) => !UNSUPPORTED.has(k))
        .map(([k, v]) => [k, sanitizeSchema(v)]),
    );
  }
  return schema;
}

export function toDeclarations(tools: ToolSpec[]): FunctionDeclaration[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parametersJsonSchema: sanitizeSchema(t.inputSchema),
  }));
}

export function toContents(messages: Message[]): Content[] {
  return messages.map((m): Content => {
    switch (m.role) {
      case "user":
        return { role: "user", parts: [{ text: m.text }] };
      case "assistant": {
        if (m.raw) return m.raw as Content;
        const parts: Part[] = [];
        if (m.text) parts.push({ text: m.text });
        for (const c of m.toolCalls) parts.push({ functionCall: { name: c.name, args: c.args } });
        return { role: "model", parts };
      }
      case "tool":
        return {
          role: "user",
          parts: m.results.map((r) => ({
            functionResponse: {
              name: r.name,
              response: r.isError ? { error: r.text } : { output: r.text },
            },
          })),
        };
    }
  });
}

export class GeminiClient implements LLMClient {
  readonly provider = "gemini";
  private readonly ai: GoogleGenAI;

  constructor(
    readonly model: string,
    apiKey: string,
  ) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const res = await withRetry(() =>
      this.ai.models.generateContent({
        model: this.model,
        contents: toContents(req.messages),
        config: {
          systemInstruction: req.system,
          tools: req.tools.length ? [{ functionDeclarations: toDeclarations(req.tools) }] : undefined,
        },
      }),
    );

    const candidate = res.candidates?.[0];
    const toolCalls: ToolCall[] = (res.functionCalls ?? []).map((c, i) => ({
      id: c.id ?? `call_${Date.now().toString(36)}_${i}`,
      name: c.name ?? "",
      args: (c.args ?? {}) as Record<string, unknown>,
    }));
    const text = (candidate?.content?.parts ?? [])
      .filter((p) => typeof p.text === "string" && !p.thought)
      .map((p) => p.text)
      .join("");

    const reason = candidate?.finishReason as string | undefined;
    let finish: ChatResponse["finish"] = "other";
    if (toolCalls.length) finish = "tool_calls";
    else if (reason === "STOP") finish = "stop";
    else if (reason === "MAX_TOKENS") finish = "length";
    else if (!candidate || reason === "SAFETY" || reason === "PROHIBITED_CONTENT" || reason === "BLOCKLIST") {
      finish = "blocked";
    }

    return {
      text,
      toolCalls,
      finish,
      raw: candidate?.content,
      usage: {
        inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: res.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  }
}
