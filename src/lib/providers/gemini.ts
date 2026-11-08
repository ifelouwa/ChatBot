import { randomUUID } from "node:crypto";
import { ProviderError, type AiProvider, type CallOptions, type ModelReply, type ToolResult } from "./types";

/**
 * Google Gemini over plain HTTP. Gemini can attach "thought signatures" to any
 * part of a reply and expects them back on later turns, so every part is
 * stored and resent exactly as received.
 */

type Part = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args?: unknown; id?: string };
  functionResponse?: unknown;
};
type Chunk = {
  candidates?: { content?: { parts?: Part[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: Record<string, number>;
};

const MAX_OUTPUT_TOKENS = 8000;
const MAX_ATTEMPTS = 3;
// Free-tier limits are per minute, so a short wait often clears a 429.
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/** Content-policy stops. Everything else unexpected is treated as a failure. */
const DECLINED = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_RECITATION",
]);

function config() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new ProviderError("Gemini", undefined, "GEMINI_API_KEY is not set");
  return {
    key,
    model: process.env.GEMINI_MODEL || "gemini-3.5-flash-lite",
    baseUrl: (process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com").replace(/\/$/, ""),
    retryBaseMs: Number(process.env.GEMINI_RETRY_BASE_MS) || 2000,
  };
}

async function errorFrom(response: Response): Promise<ProviderError> {
  const body = await response.text().catch(() => "");
  let message = body.slice(0, 300);
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; status?: string } };
    if (parsed.error?.message) message = `${parsed.error.status ?? ""} ${parsed.error.message}`.trim();
  } catch {
    // Not JSON, so the raw text is the best explanation available.
  }
  return new ProviderError("Gemini", response.status, message);
}

/** Yields each JSON object from a server-sent events stream of "data:" lines. */
async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Chunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = done ? "" : (events.pop() ?? "");
    for (const event of events) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      if (data && data !== "[DONE]") yield JSON.parse(data) as Chunk;
    }
    if (done) return;
  }
}

function toReply(parts: Part[], finishReason: string | undefined, blockReason: string | undefined): ModelReply {
  if (blockReason) {
    return { content: parts, text: "", toolCalls: [], stop: "refusal", refusalDetail: `Gemini blocked the request (${blockReason})` };
  }
  const text = parts
    .filter((part) => typeof part.text === "string" && !part.thought)
    .map((part) => part.text)
    .join("")
    .trim();
  // Calls without an ID get one, so results can be matched up. Gemini's own ID is sent back when it gave one.
  const toolCalls = parts
    .filter((part) => part.functionCall)
    .map((part) => ({
      id: part.functionCall!.id ?? `local-${randomUUID()}`,
      name: part.functionCall!.name,
      input: part.functionCall!.args ?? {},
    }));

  if (finishReason && DECLINED.has(finishReason)) {
    return { content: parts, text, toolCalls: [], stop: "refusal", refusalDetail: `Gemini stopped the reply (${finishReason})` };
  }
  if (finishReason === "MAX_TOKENS") return { content: parts, text, toolCalls, stop: "max_tokens" };
  if (finishReason && finishReason !== "STOP" && finishReason !== "FINISH_REASON_UNSPECIFIED") {
    throw new ProviderError("Gemini", undefined, `Reply ended unexpectedly (${finishReason})`);
  }
  return { content: parts, text, toolCalls, stop: toolCalls.length > 0 ? "tool_use" : "end" };
}

export const gemini: AiProvider = {
  id: "gemini",

  userContent: (context, text) => [{ text: context }, { text }],

  // Gemini's own call IDs are local- prefixed only when it didn't send one, and those aren't sent back.
  toolResultContent: (results: ToolResult[]) =>
    results.map((result) => ({
      functionResponse: {
        name: result.name,
        ...(result.id.startsWith("local-") ? {} : { id: result.id }),
        response: result.isError ? { error: result.content } : { result: result.content },
      },
    })),

  async call({ system, tools, history, onText, onRetry }: CallOptions): Promise<ModelReply> {
    const { key, model, baseUrl, retryBaseMs } = config();
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: history.map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: message.content,
      })),
      tools: [
        {
          functionDeclarations: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parametersJsonSchema: tool.inputSchema,
          })),
        },
      ],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
    });

    for (let attempt = 1; ; attempt++) {
      const response = await fetch(`${baseUrl}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body,
        signal: AbortSignal.timeout(45_000),
      });
      if (!response.ok || !response.body) {
        const error = await errorFrom(response);
        if (attempt < MAX_ATTEMPTS && RETRYABLE.has(response.status)) {
          await new Promise((resolve) => setTimeout(resolve, retryBaseMs * 3 ** (attempt - 1)));
          continue;
        }
        throw error;
      }

      const parts: Part[] = [];
      let finishReason: string | undefined;
      let blockReason: string | undefined;
      let usage: Record<string, number> | undefined;
      try {
        for await (const chunk of readEvents(response.body)) {
          blockReason ??= chunk.promptFeedback?.blockReason;
          usage = chunk.usageMetadata ?? usage;
          const candidate = chunk.candidates?.[0];
          finishReason = candidate?.finishReason ?? finishReason;
          for (const part of candidate?.content?.parts ?? []) {
            parts.push(part);
            if (typeof part.text === "string" && part.text && !part.thought) onText(part.text);
          }
        }
      } catch (error) {
        // A dropped connection mid-reply: start the reply again.
        if (attempt >= MAX_ATTEMPTS) throw error;
        onRetry();
        continue;
      }

      console.info(
        `Gemini usage: model=${model} finish=${finishReason ?? "none"} input=${usage?.promptTokenCount ?? "?"} ` +
          `output=${usage?.candidatesTokenCount ?? "?"} thinking=${usage?.thoughtsTokenCount ?? 0}`,
      );
      return toReply(parts, finishReason, blockReason);
    }
  },
};
