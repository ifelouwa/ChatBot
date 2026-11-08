import Link from "next/link";
import { notFound } from "next/navigation";
import { getConversation, getLead, loadDisplayMessages } from "@/lib/conversations";
import { db } from "@/lib/db";
import { conversationIdSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Handoff = { trigger: string; reason: string; summary: string | null };
type Alert = { id: string; channel: string; kind: string; status: string; last_error: string | null };

const TRIGGERS: Record<string, string> = {
  assistant: "The assistant couldn't answer",
  visitor: "The visitor asked for a person",
  failure: "The assistant failed",
  limit: "A usage limit was reached",
};

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const id = conversationIdSchema.safeParse((await params).id);
  if (!id.success) notFound();
  const conversation = await getConversation(id.data);
  if (!conversation) notFound();

  const pool = db();
  const [messages, lead, handoffs, alerts] = await Promise.all([
    loadDisplayMessages(pool, id.data),
    getLead(pool, id.data),
    pool.query<Handoff>(`SELECT trigger, reason, summary FROM handoffs WHERE conversation_id = $1`, [id.data]),
    pool.query<Alert>(
      `SELECT id, channel, kind, status, last_error FROM notifications WHERE conversation_id = $1 ORDER BY id`,
      [id.data],
    ),
  ]);
  const handoff = handoffs.rows[0];

  return (
    <>
      <Link href="/admin">Back to inbox</Link>
      <h1>{lead?.name ?? "Unknown visitor"}</h1>
      <div className="admin-grid">
        <section className="admin-transcript" aria-label="Transcript">
          {messages.map((message) => (
            <div className={`bubble bubble-${message.role}`} key={message.id}>
              {message.text}
            </div>
          ))}
        </section>

        <aside className="admin-side">
          <div className="card">
            <h2>Contact</h2>
            {lead ? (
              <>
                <p className="detail">
                  <span className="detail-label">Phone</span>
                  <a href={`tel:${lead.phone.replace(/[^\d+]/g, "")}`}>{lead.phone}</a>
                </p>
                {lead.email && (
                  <p className="detail">
                    <span className="detail-label">Email</span>
                    <a href={`mailto:${lead.email}`}>{lead.email}</a>
                  </p>
                )}
                <p className="detail">
                  <span className="detail-label">Need</span>
                  {lead.need}
                </p>
              </>
            ) : (
              <p className="detail">The visitor hasn't left contact details yet.</p>
            )}
          </div>

          {handoff && (
            <div className="card">
              <h2>Handover</h2>
              <p className="detail">
                <span className="detail-label">Why</span>
                {TRIGGERS[handoff.trigger]}: {handoff.reason}
              </p>
              {handoff.summary && (
                <p className="detail">
                  <span className="detail-label">Summary</span>
                  {handoff.summary}
                </p>
              )}
            </div>
          )}

          <div className="card">
            <h2>Alerts</h2>
            {alerts.rows.length === 0 && <p className="detail">None sent.</p>}
            {alerts.rows.map((alert) => (
              <p className="detail" key={alert.id}>
                {alert.kind.replace(/_/g, " ")} by {alert.channel}: <strong>{alert.status}</strong>
                {alert.last_error && <span className="error-text"> ({alert.last_error})</span>}
              </p>
            ))}
          </div>
        </aside>
      </div>
    </>
  );
}
