import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadActivity } from "@/lib/activity";
import { handleVisitorMessage, handOffWithFixedReply, type ChatEvent } from "@/lib/chat";
import { claimTurn, createConversation, getConversation, getLead, loadDisplayMessages, loadPromptHistory, releaseTurn, saveLead } from "@/lib/conversations";
import { db, transaction } from "@/lib/db";
import { deliverDueNotifications } from "@/lib/notify";
import { leadSchema } from "@/lib/validation";

vi.spyOn(console, "info").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

async function turn(id: string, text: string) {
  const conversation = await claimTurn(id);
  const events: ChatEvent[] = [];
  await handleVisitorMessage(conversation!, text, (event) => events.push(event));
  await releaseTurn(id);
  return events;
}

const replyText = (events: ChatEvent[]) =>
  events.flatMap((event) => (event.type === "delta" ? [event.text] : [])).join("");
const handoffEvent = (events: ChatEvent[]) => events.find((event) => event.type === "handoff");

async function alerts(id: string) {
  const { rows } = await db().query<{ kind: string }>(
    `SELECT kind FROM notifications WHERE conversation_id = $1 ORDER BY id`,
    [id],
  );
  return rows.map((row) => row.kind);
}

afterAll(async () => {
  await db().end();
  delete (globalThis as { enquiryPool?: unknown }).enquiryPool;
  delete process.env.AI_PROVIDER;
});

// Every conversation test runs once per AI provider.
describe.each(["claude", "gemini"] as const)("with %s", (provider) => {
beforeAll(() => {
  process.env.AI_PROVIDER = provider;
});
const providerName = provider === "claude" ? "Claude" : "Gemini";

it("starts conversations on the configured provider and hides the model's reasoning", async () => {
  const { id, provider: stored } = await createConversation();
  expect(stored).toBe(provider);
  // Gemini's fake reply includes a thought part and a signature on an empty
  // part. The second turn fails if either was altered in storage.
  await turn(id, "I'm Sam, 555 010 2099");
  const events = await turn(id, "How much is a tune-up?");
  expect(replyText(events)).toContain("$85");
  const shown = (await loadDisplayMessages(db(), id)).map((m) => m.text).join(" ");
  expect(shown).not.toContain("FAKE-HIDDEN-THOUGHT");
  expect((await getConversation(id))?.status).toBe("ai");
});

describe("answering", () => {
  it("streams a reply and stores the history for the next turn", async () => {
    const { id } = await createConversation();
    const events = await turn(id, "How much is a tune-up?");
    expect(replyText(events)).toContain("$85");
    expect(handoffEvent(events)).toBeUndefined();
    expect((await getConversation(id))?.status).toBe("ai");
    expect((await loadPromptHistory(id)).map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});

describe("lead capture", () => {
  it("saves the lead, queues one alert and keeps tool traffic out of the transcript", async () => {
    const { id } = await createConversation();
    await turn(id, "Please book me in");
    const events = await turn(id, "I'm Sam, call me on 555 010 2030");
    expect(await getLead(db(), id)).toEqual({ name: "Sam", phone: "555 010 2030", need: "A standard tune-up", email: null });
    expect(await alerts(id)).toEqual(["new_lead"]);
    expect(replyText(events)).toContain("team will contact you");

    const roles = (await loadPromptHistory(id)).map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
    const shown = (await loadDisplayMessages(db(), id)).map((m) => m.text);
    expect(shown.join(" ")).not.toContain("tool_result");
    expect(shown.join(" ")).not.toContain("<context>");
  });

  it("refuses a phone number the visitor never gave", async () => {
    const { id } = await createConversation();
    await turn(id, "invented number please");
    expect(await getLead(db(), id)).toBeNull();
    expect(await alerts(id)).toEqual([]);
  });

  it("alerts again only when details change", async () => {
    const { id } = await createConversation();
    const lead = { name: "Ana", phone: "5550100200", need: "Brakes" };
    await transaction((tx) => saveLead(tx, id, lead, "form"));
    await transaction((tx) => saveLead(tx, id, lead, "form"));
    expect(await alerts(id)).toEqual(["new_lead"]);
    await transaction((tx) => saveLead(tx, id, { ...lead, phone: "5550100999" }, "form"));
    expect(await alerts(id)).toEqual(["new_lead", "lead_updated"]);
  });

  it("validates phone numbers", () => {
    const check = (phone: string) => leadSchema.safeParse({ name: "A", need: "B", phone }).success;
    expect(check("+1 (555) 010-2030")).toBe(true);
    expect(check("12345")).toBe(false);
    expect(check("call me maybe")).toBe(false);
    expect(check("1234567890123456")).toBe(false);
  });
});

describe("customer confirmation email", () => {
  it("queues one confirmation when the visitor gives an email address in chat", async () => {
    const { id } = await createConversation();
    const events = await turn(id, "I'm Sam, 555 010 2050, Sam.Rider@Example.com");
    expect((await getLead(db(), id))?.email).toBe("sam.rider@example.com");
    expect(await alerts(id)).toEqual(["new_lead", "customer_confirmation"]);
    expect(replyText(events)).toContain("confirmation email is on its way to sam.rider@example.com");

    // Saving again, even with a changed detail, never sends a second confirmation.
    await transaction((tx) =>
      saveLead(tx, id, { name: "Sam", phone: "5550102051", need: "Tune-up", email: "sam.rider@example.com" }, "form"),
    );
    expect((await alerts(id)).filter((kind) => kind === "customer_confirmation")).toHaveLength(1);
  });

  it("rejects an email address the visitor never gave", async () => {
    const { id } = await createConversation();
    await turn(id, "invented email please, my number is 555 010 2030");
    expect(await getLead(db(), id)).toBeNull();
  });

  it("caps confirmations to one address at three a day", async () => {
    const results: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      const { id } = await createConversation();
      const lead = { name: "Kim", phone: "5550103000", need: "Brakes", email: `cap-${provider}@example.com` };
      results.push((await transaction((tx) => saveLead(tx, id, lead, "form"))).confirmationQueued);
    }
    expect(results).toEqual([true, true, true, false]);
  });

  it("treats a blank email field as not given", () => {
    const base = { name: "A", phone: "5550100000", need: "B" };
    expect(leadSchema.parse({ ...base, email: "" }).email).toBeUndefined();
    expect(leadSchema.safeParse({ ...base, email: "not-an-email" }).success).toBe(false);
  });
});

describe("activity panel", () => {
  it("lists only what really happened, in order", async () => {
    const { id } = await createConversation();
    expect(await loadActivity(db(), id)).toEqual([]);

    await turn(id, "I'm Sam, 555 010 2060, sam60@example.com");
    await deliverDueNotifications();
    await turn(id, "Can I talk to a person?");
    await deliverDueNotifications();

    const items = await loadActivity(db(), id);
    expect(items.map((item) => item.label)).toEqual([
      "Lead saved to the database",
      "Owner alerted by the server log (demo mode)",
      "Confirmation email written (demo mode, not sent)",
      "Handed to a person",
      "Owner alerted by the server log (demo mode)",
    ]);
    expect(items.every((item) => item.status === "done")).toBe(true);
  });

  it("shows a failed alert as failed, without the provider's error", async () => {
    const { id } = await createConversation();
    await db().query(
      `INSERT INTO notifications (conversation_id, channel, kind, payload, status, attempts, last_error)
       VALUES ($1, 'email', 'new_lead', '{"title":"New enquiry"}', 'failed', 6, 'secret provider detail')`,
      [id],
    );
    const [item] = await loadActivity(db(), id);
    expect(item).toMatchObject({ label: "Owner alerted by email", status: "failed" });
    expect(JSON.stringify(item)).not.toContain("secret provider detail");
  });
});

describe("handoff", () => {
  it("hands over when the assistant can't answer, asks for contact details and turns the AI off", async () => {
    const { id } = await createConversation();
    const events = await turn(id, "My frame has a crack, can you fix it?");
    expect(handoffEvent(events)).toEqual({ type: "handoff", contactRequired: true });
    expect((await getConversation(id))?.status).toBe("handed_off");
    expect(await alerts(id)).toEqual(["handoff"]);

    const historyBefore = (await loadPromptHistory(id)).length;
    const followup = await turn(id, "Also, it's a blue bike");
    expect(replyText(followup)).toContain("passed that on");
    expect((await loadPromptHistory(id)).length).toBe(historyBefore);
    expect(await alerts(id)).toEqual(["handoff", "followup"]);

    await transaction((tx) => saveLead(tx, id, { name: "Lee", phone: "5550100300", need: "Cracked frame" }, "form"));
    expect((await alerts(id)).at(-1)).toBe("handoff_contact");
  });

  it("doesn't ask for contact details it already has", async () => {
    const { id } = await createConversation();
    await turn(id, "I'm Sam, 555 010 2040");
    const events = await turn(id, "Can I talk to a person?");
    expect(handoffEvent(events)).toEqual({ type: "handoff", contactRequired: false });
  });

  it("only hands off once", async () => {
    const { id } = await createConversation();
    await handOffWithFixedReply(id, { trigger: "visitor", reason: "Asked" });
    await handOffWithFixedReply(id, { trigger: "visitor", reason: "Asked again" });
    expect(await alerts(id)).toEqual(["handoff"]);
  });

  it("hands over instead of showing an error when Claude is down", async () => {
    const { id } = await createConversation();
    const events = await turn(id, "simulate outage");
    expect(handoffEvent(events)).toEqual({ type: "handoff", contactRequired: true });
    expect(replyText(events)).toContain("passed this conversation to the team");
    const { rows } = await db().query(`SELECT trigger, reason FROM handoffs WHERE conversation_id = $1`, [id]);
    expect(rows[0].trigger).toBe("failure");
    // The owner sees why, so setup problems like an empty balance are obvious.
    expect(rows[0].reason).toContain(`${providerName} API error 500`);
    expect(rows[0].reason).toContain("Simulated outage");
  });

  it("hands over when Claude declines", async () => {
    const { id } = await createConversation();
    const events = await turn(id, "simulate refusal");
    expect(handoffEvent(events)).toBeDefined();
    expect((await getConversation(id))?.status).toBe("handed_off");
  });

  it("hands over at the conversation limit without calling Claude", async () => {
    const { id } = await createConversation();
    await db().query(`UPDATE conversations SET turn_count = 40 WHERE id = $1`, [id]);
    const events = await turn(id, "How much is a tune-up?");
    expect(replyText(events)).not.toContain("$85");
    expect(handoffEvent(events)).toBeDefined();
  });
});

describe("concurrency", () => {
  it("allows one reply at a time per conversation", async () => {
    const { id } = await createConversation();
    expect(await claimTurn(id)).not.toBeNull();
    expect(await claimTurn(id)).toBeNull();
    await releaseTurn(id);
    expect(await claimTurn(id)).not.toBeNull();
    await releaseTurn(id);
  });
});

describe("notification delivery", () => {
  it("retries a failed alert and records the error", async () => {
    const { id } = await createConversation();
    await db().query(`UPDATE notifications SET status = 'sent' WHERE status <> 'sent'`);
    await db().query(
      `INSERT INTO notifications (conversation_id, channel, kind, payload)
       VALUES ($1, 'carrier-pigeon', 'new_lead', '{"title":"t","name":"n","phone":"p","need":"x","note":"","link":"l"}')`,
      [id],
    );
    await deliverDueNotifications();
    const failed = await db().query(`SELECT status, attempts, last_error, next_attempt_at > now() AS later FROM notifications WHERE conversation_id = $1`, [id]);
    expect(failed.rows[0]).toMatchObject({ status: "pending", attempts: 1, later: true });
    expect(failed.rows[0].last_error).toContain("carrier-pigeon");

    await db().query(`UPDATE notifications SET channel = 'log', next_attempt_at = now() WHERE conversation_id = $1`, [id]);
    await deliverDueNotifications();
    const sent = await db().query(`SELECT status, attempts, last_error FROM notifications WHERE conversation_id = $1`, [id]);
    expect(sent.rows[0]).toMatchObject({ status: "sent", attempts: 2, last_error: null });
  });

  it("gives up after six attempts", async () => {
    const { id } = await createConversation();
    await db().query(
      `INSERT INTO notifications (conversation_id, channel, kind, payload, attempts)
       VALUES ($1, 'carrier-pigeon', 'new_lead', '{"title":"t","name":"n","phone":"p","need":"x","note":"","link":"l"}', 5)`,
      [id],
    );
    await deliverDueNotifications();
    const { rows } = await db().query(`SELECT status FROM notifications WHERE conversation_id = $1`, [id]);
    expect(rows[0].status).toBe("failed");
  });
});
});
