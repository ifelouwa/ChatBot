import {
  appendFixedReply,
  appendMessage,
  CONTACT_REQUEST,
  getLead,
  HANDOFF_MESSAGE,
  loadPromptHistory,
  startHandoff,
  type Conversation,
  type HandoffTrigger,
} from "./conversations";
import { db, transaction } from "./db";
import { enqueueNotification } from "./notify";
import { SYSTEM_PROMPT, timeContext } from "./prompt";
import { providerFor, ProviderError } from "./providers";
import { allowAiTurnToday, limits } from "./rate-limit";
import { runTool, TOOLS, type ToolOutcome } from "./tools";

export type ChatEvent =
  | { type: "conversation"; id: string }
  | { type: "delta"; text: string }
  /** Discard the reply bubble being streamed. */
  | { type: "reset" }
  /** Start a new reply bubble. */
  | { type: "break" }
  | { type: "handoff"; contactRequired: boolean }
  /** Something the activity panel shows has changed. */
  | { type: "activity" }
  | { type: "done" };

type Emit = (event: ChatEvent) => void;

const MAX_MODEL_CALLS_PER_TURN = 5;
const FOLLOWUP_REPLY = "Thanks, I've passed that on to the team as well.";
const FOLLOWUP_CONTACT_REPLY = `Thanks, I've passed that on.${CONTACT_REQUEST}`;
const EMPTY_REPLY = "Thanks. Is there anything else I can help you with?";

/** Runs the visitor's message through the AI, tools included, until it replies. */
async function runAssistant(conversation: Conversation, emit: Emit): Promise<void> {
  const conversationId = conversation.id;
  const provider = providerFor(conversation.provider);
  let wroteText = false;

  for (let call = 0; call < MAX_MODEL_CALLS_PER_TURN; call++) {
    const history = await loadPromptHistory(conversationId);
    const reply = await provider.call({
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      history,
      onText: (text) => emit({ type: "delta", text }),
      onRetry: () => emit({ type: "reset" }),
    });

    if (reply.stop === "refusal") throw new Error(reply.refusalDetail ?? "The AI declined to reply");
    const toolUses = reply.toolCalls;
    // A tool input cut off here can still look valid, so it must not run.
    if (reply.stop === "max_tokens" && toolUses.length > 0) {
      throw new Error("Reply hit max_tokens during a tool call");
    }

    const text = reply.text;
    wroteText ||= Boolean(text);
    const hasContent = Array.isArray(reply.content) && reply.content.length > 0;

    if (toolUses.length === 0) {
      if (hasContent) {
        await appendMessage(db(), {
          conversationId,
          role: "assistant",
          content: reply.content,
          displayText: text || null,
        });
      }
      if (reply.stop !== "pause") break;
      continue;
    }

    // The reply, the tool effects and their results are saved together, so a
    // crash can't leave a tool call in the history without its result.
    const outcomes = await transaction(async (tx) => {
      await appendMessage(tx, {
        conversationId,
        role: "assistant",
        content: reply.content,
        displayText: text || null,
      });
      // Leads first: a handoff in the same reply should see the new contact details.
      const ordered = [...toolUses].sort(
        (a, b) => Number(a.name !== "save_lead") - Number(b.name !== "save_lead"),
      );
      const byId = new Map<string, ToolOutcome>();
      for (const block of ordered) byId.set(block.id, await runTool(tx, conversationId, block));
      const inOrder = toolUses.map((block) => byId.get(block.id)!);
      await appendMessage(tx, {
        conversationId,
        role: "user",
        content: provider.toolResultContent(inOrder.map((outcome) => outcome.result)),
        displayText: null,
      });
      return inOrder;
    });

    for (const outcome of outcomes) {
      if (outcome.handedOff) emit({ type: "handoff", contactRequired: outcome.handedOff.contactRequired });
    }
    emit({ type: "activity" });
    if (text) emit({ type: "break" });
  }

  if (!wroteText) {
    const reply = await fallbackReply(conversationId);
    await appendFixedReply(db(), conversationId, reply);
    emit({ type: "delta", text: reply });
  }
}

async function fallbackReply(conversationId: string): Promise<string> {
  const { rows } = await db().query<{ status: string }>(`SELECT status FROM conversations WHERE id = $1`, [
    conversationId,
  ]);
  if (rows[0]?.status !== "handed_off") return EMPTY_REPLY;
  const lead = await getLead(db(), conversationId);
  return lead ? HANDOFF_MESSAGE : HANDOFF_MESSAGE + CONTACT_REQUEST;
}

/** Hands over without Claude. Used for failures, limits and the visitor's button. */
export async function handOffWithFixedReply(
  conversationId: string,
  handoff: { trigger: HandoffTrigger; reason: string },
): Promise<{ reply: string; contactRequired: boolean }> {
  return transaction(async (tx) => {
    const { lead } = await startHandoff(tx, conversationId, handoff);
    const reply = lead ? HANDOFF_MESSAGE : HANDOFF_MESSAGE + CONTACT_REQUEST;
    await appendFixedReply(tx, conversationId, reply);
    return { reply, contactRequired: !lead };
  });
}

async function fixedHandoff(conversationId: string, trigger: HandoffTrigger, reason: string, emit: Emit) {
  const { reply, contactRequired } = await handOffWithFixedReply(conversationId, { trigger, reason });
  emit({ type: "delta", text: reply });
  emit({ type: "handoff", contactRequired });
  emit({ type: "activity" });
}

/**
 * Handles one visitor message. Every path ends with a reply: if Claude is
 * unavailable or declines, the visitor is handed to a person rather than
 * shown an error, so an enquiry is never lost.
 */
export async function handleVisitorMessage(conversation: Conversation, text: string, emit: Emit): Promise<void> {
  const conversationId = conversation.id;

  if (conversation.status === "handed_off") {
    const reply = await transaction(async (tx) => {
      await appendMessage(tx, {
        conversationId,
        role: "user",
        content: [{ type: "text", text }],
        displayText: text,
        inPrompt: false,
      });
      const lead = await getLead(tx, conversationId);
      await enqueueNotification(tx, conversationId, "followup", { ...lead, note: text });
      const fixed = lead ? FOLLOWUP_REPLY : FOLLOWUP_CONTACT_REPLY;
      await appendFixedReply(tx, conversationId, fixed);
      return { fixed, contactRequired: !lead };
    });
    emit({ type: "delta", text: reply.fixed });
    emit({ type: "handoff", contactRequired: reply.contactRequired });
    emit({ type: "activity" });
    return;
  }

  await transaction(async (tx) => {
    await appendMessage(tx, {
      conversationId,
      role: "user",
      content: providerFor(conversation.provider).userContent(timeContext(), text),
      displayText: text,
    });
    await tx.query(`UPDATE conversations SET turn_count = turn_count + 1 WHERE id = $1`, [conversationId]);
  });

  if (conversation.turn_count >= limits.turnsPerConversation()) {
    await fixedHandoff(conversationId, "limit", "Conversation reached the message limit", emit);
    return;
  }
  if (!(await allowAiTurnToday())) {
    await fixedHandoff(conversationId, "limit", "Site reached its daily AI limit", emit);
    return;
  }

  try {
    await runAssistant(conversation, emit);
  } catch (error) {
    console.error(`Assistant failed for conversation ${conversationId}:`, error);
    emit({ type: "reset" });
    await fixedHandoff(conversationId, "failure", failureReason(error), emit);
  }
}

/**
 * Tells the owner why the AI stopped, so a setup problem such as an empty
 * credit balance or a revoked key is obvious from the first alert. Visitors
 * never see this.
 */
function failureReason(error: unknown): string {
  const base = "The assistant couldn't reply to this message";
  if (error instanceof ProviderError || error instanceof Error) return `${base}. ${error.message}`.slice(0, 300);
  return base;
}
