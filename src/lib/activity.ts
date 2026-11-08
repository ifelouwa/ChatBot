import type { Queryable } from "./db";
import { CUSTOMER_CONFIRMATION } from "./notify";

export type ActivityStatus = "done" | "sending" | "retrying" | "failed";
export type ActivityItem = { key: string; label: string; detail: string; status: ActivityStatus; at: string };

const CHANNELS: Record<string, string> = {
  email: "email",
  whatsapp: "WhatsApp",
  log: "the server log (demo mode)",
};

const TRIGGERS: Record<string, string> = {
  assistant: "The AI couldn't answer",
  visitor: "You asked for a person",
  failure: "The AI had a problem",
  limit: "A usage limit was reached",
};

/** Delivery problems are shown as a status only. Provider errors stay in the owner's inbox. */
function deliveryStatus(status: string, attempts: number): ActivityStatus {
  if (status === "sent") return "done";
  if (status === "failed") return "failed";
  return attempts > 0 ? "retrying" : "sending";
}

/**
 * What the automation has done in one conversation, built from the database
 * rather than from what the AI says, so the panel only shows real events.
 */
export async function loadActivity(q: Queryable, conversationId: string): Promise<ActivityItem[]> {
  const [leads, handoffs, notifications] = await Promise.all([
    q.query<{ name: string; need: string; created_at: Date }>(
      `SELECT name, need, created_at FROM leads WHERE conversation_id = $1`,
      [conversationId],
    ),
    q.query<{ trigger: string; reason: string; created_at: Date }>(
      `SELECT trigger, reason, created_at FROM handoffs WHERE conversation_id = $1`,
      [conversationId],
    ),
    q.query<{ id: string; channel: string; kind: string; status: string; attempts: number; payload: { title?: string; to?: string }; created_at: Date }>(
      `SELECT id, channel, kind, status, attempts, payload, created_at
         FROM notifications WHERE conversation_id = $1 ORDER BY id`,
      [conversationId],
    ),
  ]);

  const items: ActivityItem[] = [];
  for (const lead of leads.rows) {
    items.push({
      key: "lead",
      label: "Lead saved to the database",
      detail: `${lead.name}: ${lead.need}`,
      status: "done",
      at: lead.created_at.toISOString(),
    });
  }
  for (const handoff of handoffs.rows) {
    items.push({
      key: "handoff",
      label: "Handed to a person",
      detail: `${TRIGGERS[handoff.trigger] ?? "Handed over"}. The AI has stopped replying in this chat.`,
      status: "done",
      at: handoff.created_at.toISOString(),
    });
  }
  for (const n of notifications.rows) {
    const status = deliveryStatus(n.status, n.attempts);
    const customer = n.kind === CUSTOMER_CONFIRMATION;
    items.push({
      key: `notification-${n.id}`,
      label: customer
        ? n.channel === "customer_email"
          ? "Confirmation emailed to you"
          : "Confirmation email written (demo mode, not sent)"
        : `Owner alerted by ${CHANNELS[n.channel] ?? n.channel}`,
      detail: customer ? (n.payload.to ?? "") : (n.payload.title ?? ""),
      status,
      at: n.created_at.toISOString(),
    });
  }
  // Same-moment events keep a readable order: lead, handover, then alerts.
  return items.sort((a, b) => a.at.localeCompare(b.at));
}
