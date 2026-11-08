import Anthropic from "@anthropic-ai/sdk";
import { ProviderError, type AiProvider, type CallOptions, type ModelReply, type ToolResult } from "./types";

const MAX_MALFORMED_RETRIES = 2;
// Generous for a short reply, but stops one request from running up a large bill.
const MAX_TOKENS = 8000;

function client(): Anthropic {
  // Reads ANTHROPIC_API_KEY. Retries rate limits and overloads twice by default.
  return new Anthropic({ timeout: 45_000 });
}

function modelName(): string {
  return process.env.CLAUDE_MODEL || "claude-opus-5-5";
}

function toReply(message: Anthropic.Beta.BetaMessage): ModelReply {
  const text = message.content
    .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  const toolCalls = message.content
    .filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use")
    .map((block) => ({ id: block.id, name: block.name, input: block.input }));
  const stop: ModelReply["stop"] =
    message.stop_reason === "refusal"
      ? "refusal"
      : message.stop_reason === "max_tokens"
        ? "max_tokens"
        : message.stop_reason === "pause_turn"
          ? "pause"
          : toolCalls.length > 0
            ? "tool_use"
            : "end";
  return {
    content: message.content,
    text,
    toolCalls,
    stop,
    refusalDetail: stop === "refusal" ? `Claude declined (category: ${message.stop_details?.category ?? "none"})` : undefined,
  };
}

export const claude: AiProvider = {
  id: "claude",

  userContent: (context, text) => [
    { type: "text", text: context },
    { type: "text", text },
  ],

  toolResultContent: (results: ToolResult[]) =>
    results.map((result) => ({
      type: "tool_result",
      tool_use_id: result.id,
      content: result.content,
      ...(result.isError ? { is_error: true } : {}),
    })),

  async call({ system, tools, history, onText, onRetry }: CallOptions): Promise<ModelReply> {
    const model = modelName();
    // Haiku has no server-side refusal fallback and rejects the parameter.
    const fallback = model.startsWith("claude-haiku")
      ? {}
      : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const };

    for (let attempt = 0; ; attempt++) {
      const stream = client().beta.messages.stream({
        model,
        max_tokens: MAX_TOKENS,
        // Short factual replies don't benefit from deeper effort.
        output_config: { effort: "low" },
        cache_control: { type: "ephemeral" },
        system,
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema,
          eager_input_streaming: true,
        })),
        messages: history as Anthropic.Beta.BetaMessageParam[],
        ...fallback,
      } as Anthropic.Beta.Messages.MessageCreateParamsStreaming);
      stream.on("text", onText);
      try {
        const message = await stream.finalMessage();
        console.info(
          `Claude usage: model=${message.model} stop=${message.stop_reason} input=${message.usage.input_tokens} ` +
            `output=${message.usage.output_tokens} cache_read=${message.usage.cache_read_input_tokens ?? 0}`,
        );
        return toReply(message);
      } catch (error) {
        if (error instanceof Anthropic.APIError) {
          const detail = (error as { apiMessage?: string }).apiMessage ?? error.message;
          throw new ProviderError("Claude", error.status, detail);
        }
        // Tool input that couldn't be parsed at all is the only retryable case here.
        if (attempt >= MAX_MALFORMED_RETRIES) throw error;
        onRetry();
      }
    }
  },
};
