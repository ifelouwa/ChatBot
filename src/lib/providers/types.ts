/** A stored message, in the format of the provider that wrote the conversation. */
export type StoredMessage = { role: "user" | "assistant"; content: unknown };

export type ToolDefinition = { name: string; description: string; inputSchema: Record<string, unknown> };
export type ToolCall = { id: string; name: string; input: unknown };
export type ToolResult = { id: string; name: string; content: string; isError: boolean };

export type ModelReply = {
  /** Exactly what the model returned, stored and sent back unchanged. */
  content: unknown;
  /** The visible reply text, if any. */
  text: string;
  toolCalls: ToolCall[];
  stop: "end" | "tool_use" | "max_tokens" | "pause" | "refusal";
  /** Why the provider declined, for the owner's handover note. */
  refusalDetail?: string;
};

export type CallOptions = {
  system: string;
  tools: ToolDefinition[];
  history: StoredMessage[];
  onText: (text: string) => void;
  /** Throw away text streamed so far, because the call is being retried. */
  onRetry: () => void;
};

export interface AiProvider {
  id: ProviderId;
  /** Content of a visitor message: the website context, then their text. */
  userContent(context: string, text: string): unknown;
  /** Content of the message that answers the model's tool calls. */
  toolResultContent(results: ToolResult[]): unknown;
  call(options: CallOptions): Promise<ModelReply>;
}

export type ProviderId = "claude" | "gemini";

/** An API failure, with a message the owner can act on. */
export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number | undefined,
    message: string,
  ) {
    super(`${provider} API error ${status ?? ""}: ${message}`.replace(/\s+:/, ":"));
    this.name = "ProviderError";
  }
}
