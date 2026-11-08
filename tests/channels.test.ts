import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createConversation } from "@/lib/conversations";
import { db } from "@/lib/db";
import { deliverDueNotifications, enqueueCustomerConfirmation, enqueueNotification } from "@/lib/notify";

const fetchMock = vi.fn(async (..._args: [string, RequestInit]) => new Response("{}", { status: 200 }));

beforeAll(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
  Object.assign(process.env, {
    RESEND_API_KEY: "resend-test",
    NOTIFY_EMAIL_FROM: "alerts@example.com",
    NOTIFY_EMAIL_TO: "owner@example.com",
    WHATSAPP_TOKEN: "wa-test",
    WHATSAPP_PHONE_NUMBER_ID: "12345",
    WHATSAPP_TO: "15550100000",
  });
});

afterEach(() => {
  fetchMock.mockClear();
  process.env.NOTIFY_CHANNELS = "log";
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await db().end();
  delete (globalThis as { enquiryPool?: unknown }).enquiryPool;
});

async function send(channel: string, details: Parameters<typeof enqueueNotification>[3]) {
  process.env.NOTIFY_CHANNELS = channel;
  const { id } = await createConversation();
  await enqueueNotification(db(), id, "new_lead", details);
  await deliverDueNotifications();
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  const { rows } = await db().query(`SELECT status FROM notifications WHERE conversation_id = $1`, [id]);
  return { url, init, body: JSON.parse(String(init.body)), status: rows[0].status };
}

describe("email", () => {
  it("escapes visitor text, so a message can't inject HTML into the owner's inbox", async () => {
    const { url, body, status } = await send("email", {
      name: "<script>alert(1)</script>",
      phone: "555 010 2030",
      need: 'A "tune-up" & more',
    });
    expect(url).toBe("https://api.resend.com/emails");
    expect(body.html).not.toContain("<script>");
    expect(body.html).toContain("&lt;script&gt;");
    expect(body.html).toContain("&amp; more");
    expect(body.to).toEqual(["owner@example.com"]);
    expect(status).toBe("sent");
  });

  it("keeps line breaks out of the subject", async () => {
    const { body } = await send("email", { name: "Sam\r\nBcc: x@example.com", phone: "1", need: "x" });
    expect(body.subject).not.toMatch(/[\r\n]/);
  });
});

describe("customer confirmation", () => {
  it("emails fixed text to the visitor, with only the last two digits of their number", async () => {
    process.env.CUSTOMER_CONFIRMATIONS = "email";
    const { id } = await createConversation();
    await enqueueCustomerConfirmation(db(), id, "visitor@example.com", "555 010 2030");
    await deliverDueNotifications();
    delete process.env.CUSTOMER_CONFIRMATIONS;

    const [url, init] = fetchMock.mock.calls.at(-1)!;
    const body = JSON.parse(String(init.body));
    expect(url).toBe("https://api.resend.com/emails");
    expect(body.to).toEqual(["visitor@example.com"]);
    expect(body.subject).toContain("We've received your enquiry");
    expect(body.text).toContain("ending in 30");
    expect(body.text).not.toContain("555 010 2030");
    const { rows } = await db().query(`SELECT channel, status FROM notifications WHERE conversation_id = $1`, [id]);
    expect(rows[0]).toEqual({ channel: "customer_email", status: "sent" });
  });

  it("can be switched off", async () => {
    process.env.CUSTOMER_CONFIRMATIONS = "off";
    const { id } = await createConversation();
    expect(await enqueueCustomerConfirmation(db(), id, "visitor2@example.com", "5550100000")).toBe(false);
    delete process.env.CUSTOMER_CONFIRMATIONS;
  });
});

describe("WhatsApp", () => {
  it("sends the five template values with newlines removed", async () => {
    const { url, init, body, status } = await send("whatsapp", {
      name: "Sam",
      phone: "555 010 2030",
      need: "Line one\nLine two",
    });
    expect(url).toBe("https://graph.facebook.com/v24.0/12345/messages");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer wa-test");
    expect(body.type).toBe("template");
    expect(body.to).toBe("15550100000");
    const values = body.template.components[0].parameters.map((p: { text: string }) => p.text);
    expect(values).toHaveLength(5);
    expect(values.slice(0, 4)).toEqual(["New enquiry", "Sam", "555 010 2030", "Line one Line two"]);
    expect(status).toBe("sent");
  });

  it("keeps the alert for a retry when the provider rejects it", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    const { status } = await send("whatsapp", { name: "Sam", phone: "1", need: "x" });
    expect(status).toBe("pending");
  });
});
