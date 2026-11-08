import { createHash } from "node:crypto";
import { business } from "@business";
import { db, type Queryable } from "./db";

export type NotificationKind = "new_lead" | "lead_updated" | "handoff" | "handoff_contact" | "followup";

const TITLES: Record<NotificationKind, string> = {
  new_lead: "New enquiry",
  lead_updated: "Enquiry details updated",
  handoff: "A customer needs a person",
  handoff_contact: "Contact details for a handed-over customer",
  followup: "New message from a handed-over customer",
};

export type NotificationPayload = {
  title: string;
  name: string;
  phone: string;
  need: string;
  email?: string;
  note: string;
  link: string;
};

/** Deliberately holds no visitor-written text: see enqueueCustomerConfirmation. */
export type ConfirmationPayload = { to: string; phoneEnding: string };

export const CUSTOMER_CONFIRMATION = "customer_confirmation";
const CONFIRMATIONS_PER_ADDRESS_PER_DAY = 3;

type Row = { id: string; channel: string; payload: NotificationPayload & ConfirmationPayload; attempts: number };

const MAX_ATTEMPTS = 6;
const BACKOFF_MINUTES = [1, 5, 15, 60, 240];
const LEASE_MINUTES = 5;
const NOT_PROVIDED = "Not provided";

function channels(): string[] {
  return (process.env.NOTIFY_CHANNELS ?? "log")
    .split(",")
    .map((channel) => channel.trim())
    .filter(Boolean);
}

export function adminLink(conversationId: string): string {
  const base = (process.env.PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return `${base}/admin/conversations/${conversationId}`;
}

/** Stores the alert in the caller's transaction. Delivery happens after commit. */
export async function enqueueNotification(
  q: Queryable,
  conversationId: string,
  kind: NotificationKind,
  details: { name?: string; phone?: string; need?: string; email?: string | null; note?: string },
): Promise<void> {
  const payload: NotificationPayload = {
    title: TITLES[kind],
    name: details.name ?? NOT_PROVIDED,
    phone: details.phone ?? NOT_PROVIDED,
    need: details.need ?? NOT_PROVIDED,
    ...(details.email ? { email: details.email } : {}),
    note: details.note ?? "",
    link: adminLink(conversationId),
  };
  for (const channel of channels()) {
    await q.query(
      `INSERT INTO notifications (conversation_id, channel, kind, payload) VALUES ($1, $2, $3, $4)`,
      [conversationId, channel, kind, JSON.stringify(payload)],
    );
  }
}

function confirmationMode(): "email" | "log" | "off" {
  const mode = process.env.CUSTOMER_CONFIRMATIONS ?? "log";
  return mode === "email" || mode === "off" ? mode : "log";
}

/**
 * Queues the visitor's "we've got your enquiry" email. Anyone can type any
 * address into a chat, so this is built to be useless for spam: the email is
 * fixed text with no visitor-written words, each chat sends at most one, and
 * each address gets at most three a day. Returns whether one was queued.
 */
export async function enqueueCustomerConfirmation(
  q: Queryable,
  conversationId: string,
  email: string,
  phone: string,
): Promise<boolean> {
  const mode = confirmationMode();
  if (mode === "off") return false;

  const already = await q.query(`SELECT 1 FROM notifications WHERE conversation_id = $1 AND kind = $2`, [
    conversationId,
    CUSTOMER_CONFIRMATION,
  ]);
  if (already.rowCount) return false;

  const day = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000);
  const key = `confirm:${createHash("sha256").update(email).digest("hex")}`;
  const { rows } = await q.query<{ count: number }>(
    `INSERT INTO rate_limits (key, window_start, count) VALUES ($1, $2, 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
     RETURNING count`,
    [key, day],
  );
  if (rows[0]!.count > CONFIRMATIONS_PER_ADDRESS_PER_DAY) return false;

  const payload: ConfirmationPayload = { to: email, phoneEnding: phone.replace(/\D/g, "").slice(-2) };
  await q.query(
    `INSERT INTO notifications (conversation_id, channel, kind, payload) VALUES ($1, $2, $3, $4)`,
    [conversationId, mode === "email" ? "customer_email" : "customer_log", CUSTOMER_CONFIRMATION, JSON.stringify(payload)],
  );
  return true;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function assertOk(provider: string, response: Response): Promise<void> {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${provider} returned ${response.status}: ${body.slice(0, 300)}`);
  }
}

async function sendEmail(p: NotificationPayload): Promise<void> {
  // Visitors write these values, so everything is escaped before going into HTML.
  const rows = [
    ["Name", p.name],
    ["Phone", p.phone],
    ...(p.email ? [["Email", p.email] as const] : []),
    ["Need", p.need],
    ...(p.note ? [["Note", p.note] as const] : []),
  ]
    .map(
      ([label, value]) =>
        `<tr><td style="padding:4px 12px 4px 0"><strong>${label}</strong></td><td>${escapeHtml(value ?? "")}</td></tr>`,
    )
    .join("");

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${required("RESEND_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: required("NOTIFY_EMAIL_FROM"),
      to: required("NOTIFY_EMAIL_TO").split(",").map((address) => address.trim()),
      subject: `${p.title}: ${p.name}`.replace(/[\r\n]+/g, " ").slice(0, 150),
      html: `<h2>${escapeHtml(p.title)}</h2><table>${rows}</table><p><a href="${escapeHtml(p.link)}">Open the conversation</a></p>`,
      text: `${p.title}\n\nName: ${p.name}\nPhone: ${p.phone}\n${p.email ? `Email: ${p.email}\n` : ""}Need: ${p.need}\n${p.note ? `Note: ${p.note}\n` : ""}\n${p.link}`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  await assertOk("Resend", response);
}

/** WhatsApp template parameters reject newlines, tabs and long runs of spaces. */
function templateParameter(value: string): { type: "text"; text: string } {
  const clean = value.replace(/\s+/g, " ").trim().slice(0, 300);
  return { type: "text", text: clean || NOT_PROVIDED };
}

async function sendWhatsApp(p: NotificationPayload): Promise<void> {
  const version = process.env.WHATSAPP_API_VERSION || "v24.0";
  const response = await fetch(
    `https://graph.facebook.com/${version}/${required("WHATSAPP_PHONE_NUMBER_ID")}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${required("WHATSAPP_TOKEN")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: required("WHATSAPP_TO"),
        type: "template",
        template: {
          name: process.env.WHATSAPP_TEMPLATE_NAME || "enquiry_alert",
          language: { code: process.env.WHATSAPP_TEMPLATE_LANGUAGE || "en" },
          components: [
            {
              type: "body",
              parameters: [p.title, p.name, p.phone, p.note ? `${p.need} (${p.note})` : p.need, p.link].map(
                templateParameter,
              ),
            },
          ],
        },
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  await assertOk("WhatsApp", response);
}

function confirmationContent(p: ConfirmationPayload) {
  const hours = business.hours.map((entry) => `${entry.days}: ${entry.time}`);
  const lines = [
    `Thanks for getting in touch with ${business.name}.`,
    `We've received your enquiry and passed it to the team. Someone will call you on your number ending in ${p.phoneEnding}.`,
    `If you need us sooner, call ${business.phone} or visit ${business.address}.`,
    `Opening hours: ${hours.join(". ")}.`,
    `If you didn't contact us, you can ignore this email.`,
  ];
  return {
    subject: `We've received your enquiry | ${business.name}`,
    text: lines.join("\n\n"),
    html: lines.map((line) => `<p>${escapeHtml(line)}</p>`).join(""),
  };
}

async function sendCustomerEmail(p: ConfirmationPayload): Promise<void> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${required("RESEND_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: required("NOTIFY_EMAIL_FROM"), to: [p.to], ...confirmationContent(p) }),
    signal: AbortSignal.timeout(10_000),
  });
  await assertOk("Resend", response);
}

async function send(channel: string, payload: NotificationPayload & ConfirmationPayload): Promise<void> {
  switch (channel) {
    case "email":
      return sendEmail(payload);
    case "whatsapp":
      return sendWhatsApp(payload);
    case "customer_email":
      return sendCustomerEmail(payload);
    case "customer_log":
      console.info(`[${business.name}] customer confirmation to ${payload.to}:\n${confirmationContent(payload).text}`);
      return;
    case "log":
      console.info(`[${business.name}] notification:`, JSON.stringify(payload));
      return;
    default:
      throw new Error(`Unknown notification channel "${channel}"`);
  }
}

/**
 * Sends everything that's due, including earlier failures. Every chat request
 * calls this, so retries also happen whenever the site has traffic.
 */
export async function deliverDueNotifications(): Promise<void> {
  const pool = db();
  // The lease stops a concurrent request from sending the same alert twice.
  const { rows } = await pool.query<Row>(
    `UPDATE notifications
        SET status = 'sending',
            attempts = attempts + 1,
            next_attempt_at = now() + make_interval(mins => $2::int)
      WHERE id IN (
        SELECT id FROM notifications
         WHERE status IN ('pending', 'sending')
           AND next_attempt_at <= now()
           AND attempts < $1::int
         ORDER BY id
         LIMIT 25
      )
      RETURNING id, channel, payload, attempts`,
    [MAX_ATTEMPTS, LEASE_MINUTES],
  );

  for (const row of rows) {
    try {
      await send(row.channel, row.payload);
      await pool.query(
        `UPDATE notifications SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = $1`,
        [row.id],
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Notification ${row.id} via ${row.channel} failed (attempt ${row.attempts}): ${message}`);
      const finished = row.attempts >= MAX_ATTEMPTS;
      const delay = BACKOFF_MINUTES[row.attempts - 1] ?? BACKOFF_MINUTES.at(-1)!;
      await pool.query(
        `UPDATE notifications
            SET status = $2, last_error = $3, next_attempt_at = now() + make_interval(mins => $4::int)
          WHERE id = $1`,
        [row.id, finished ? "failed" : "pending", message.slice(0, 500), delay],
      );
    }
  }

  // Attempts ran out while a send was interrupted, so nothing would retry it.
  await pool.query(
    `UPDATE notifications
        SET status = 'failed', last_error = COALESCE(last_error, 'Delivery was interrupted')
      WHERE status = 'sending' AND attempts >= $1::int AND next_attempt_at <= now()`,
    [MAX_ATTEMPTS],
  );
}
