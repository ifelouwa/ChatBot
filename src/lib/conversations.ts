import { randomUUID } from "node:crypto";
import { db, type Queryable } from "./db";
import { enqueueCustomerConfirmation, enqueueNotification } from "./notify";
import { configuredProvider, type StoredMessage } from "./providers";
import type { LeadInput } from "./validation";

export type ConversationStatus = "ai" | "handed_off";
export type Conversation = { id: string; status: ConversationStatus; turn_count: number; provider: string };
const COLUMNS = "id, status, turn_count, provider";
export type Lead = { name: string; phone: string; need: string; email: string | null };
export type HandoffTrigger = "assistant" | "visitor" | "failure" | "limit";
export type DisplayMessage = { id: string; role: "user" | "assistant"; text: string; createdAt: string };

export const HANDOFF_MESSAGE =
  "I've passed this conversation to the team, and someone will follow up with you personally.";
export const CONTACT_REQUEST =
  " Please leave your name and number in the form below so they can reach you.";

export async function createConversation(): Promise<Conversation> {
  const { rows } = await db().query<Conversation>(
    `INSERT INTO conversations (id, provider) VALUES ($1, $2) RETURNING ${COLUMNS}`,
    [randomUUID(), configuredProvider()],
  );
  return rows[0]!;
}

export async function getConversation(id: string): Promise<Conversation | null> {
  const { rows } = await db().query<Conversation>(`SELECT ${COLUMNS} FROM conversations WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/** Claims the conversation for one turn. Returns null if a reply is already running. */
export async function claimTurn(id: string): Promise<Conversation | null> {
  const { rows } = await db().query<Conversation>(
    `UPDATE conversations
        SET busy_until = now() + interval '2 minutes', updated_at = now()
      WHERE id = $1 AND (busy_until IS NULL OR busy_until < now())
      RETURNING ${COLUMNS}`,
    [id],
  );
  return rows[0] ?? null;
}

export async function releaseTurn(id: string): Promise<void> {
  await db().query(`UPDATE conversations SET busy_until = NULL WHERE id = $1`, [id]);
}

export async function appendMessage(
  q: Queryable,
  message: {
    conversationId: string;
    role: "user" | "assistant";
    content: unknown;
    displayText: string | null;
    inPrompt?: boolean;
  },
): Promise<void> {
  await q.query(
    `INSERT INTO messages (conversation_id, role, content, display_text, in_prompt)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      message.conversationId,
      message.role,
      JSON.stringify(message.content),
      message.displayText,
      message.inPrompt ?? true,
    ],
  );
}

/** A fixed message the AI didn't write, so it stays out of the prompt history. */
export async function appendFixedReply(q: Queryable, conversationId: string, text: string): Promise<void> {
  await appendMessage(q, {
    conversationId,
    role: "assistant",
    content: [{ type: "text", text }],
    displayText: text,
    inPrompt: false,
  });
}

export async function loadPromptHistory(id: string): Promise<StoredMessage[]> {
  const { rows } = await db().query<StoredMessage>(
    `SELECT role, content FROM messages WHERE conversation_id = $1 AND in_prompt ORDER BY id`,
    [id],
  );
  return rows;
}

export async function loadDisplayMessages(q: Queryable, id: string): Promise<DisplayMessage[]> {
  const { rows } = await q.query<{ id: string; role: "user" | "assistant"; display_text: string; created_at: Date }>(
    `SELECT id, role, display_text, created_at FROM messages
      WHERE conversation_id = $1 AND display_text IS NOT NULL ORDER BY id`,
    [id],
  );
  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    text: row.display_text,
    createdAt: row.created_at.toISOString(),
  }));
}

export async function getLead(q: Queryable, conversationId: string): Promise<Lead | null> {
  const { rows } = await q.query<Lead>(
    `SELECT name, phone, need, email FROM leads WHERE conversation_id = $1`,
    [conversationId],
  );
  return rows[0] ?? null;
}

/**
 * Saves or updates the conversation's lead, queues the owner's alert and, if
 * the visitor gave an email address, their confirmation email.
 * Call inside a transaction. Returns whether a confirmation was queued.
 */
export async function saveLead(
  q: Queryable,
  conversationId: string,
  input: LeadInput,
  source: "assistant" | "form",
): Promise<{ confirmationQueued: boolean }> {
  const existing = await getLead(q, conversationId);
  // A later save without an email keeps the one already given.
  const email = input.email ?? existing?.email ?? null;
  await q.query(
    `INSERT INTO leads (conversation_id, name, phone, need, email, source)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (conversation_id) DO UPDATE
       SET name = EXCLUDED.name, phone = EXCLUDED.phone, need = EXCLUDED.need,
           email = EXCLUDED.email, updated_at = now()`,
    [conversationId, input.name, input.phone, input.need, email, source],
  );
  const details = { ...input, email: email ?? undefined };

  if (existing) {
    const changed =
      existing.name !== input.name ||
      existing.phone !== input.phone ||
      existing.need !== input.need ||
      existing.email !== email;
    if (changed) await enqueueNotification(q, conversationId, "lead_updated", details);
  } else {
    const { rows } = await q.query<{ status: ConversationStatus }>(
      `SELECT status FROM conversations WHERE id = $1`,
      [conversationId],
    );
    const handedOff = rows[0]?.status === "handed_off";
    await enqueueNotification(q, conversationId, handedOff ? "handoff_contact" : "new_lead", details);
  }

  if (!email) return { confirmationQueued: false };
  return { confirmationQueued: await enqueueCustomerConfirmation(q, conversationId, email, input.phone) };
}

/**
 * Turns the AI off for this conversation and alerts the owner.
 * Idempotent: a conversation only ever hands off once.
 */
export async function startHandoff(
  q: Queryable,
  conversationId: string,
  handoff: { trigger: HandoffTrigger; reason: string; summary?: string },
): Promise<{ started: boolean; lead: Lead | null }> {
  const { rowCount } = await q.query(
    `INSERT INTO handoffs (conversation_id, trigger, reason, summary)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (conversation_id) DO NOTHING`,
    [conversationId, handoff.trigger, handoff.reason, handoff.summary ?? null],
  );
  const lead = await getLead(q, conversationId);
  if (!rowCount) return { started: false, lead };

  await q.query(`UPDATE conversations SET status = 'handed_off', updated_at = now() WHERE id = $1`, [
    conversationId,
  ]);
  await enqueueNotification(q, conversationId, "handoff", {
    ...lead,
    need: lead?.need ?? handoff.summary,
    note: handoff.summary ? `${handoff.reason}. ${handoff.summary}` : handoff.reason,
  });
  return { started: true, lead };
}
