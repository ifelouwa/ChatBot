import { appendFixedReply, getConversation, saveLead } from "@/lib/conversations";
import { transaction } from "@/lib/db";
import { deliverDueNotifications } from "@/lib/notify";
import { allowRequestFromIp, isSameOrigin } from "@/lib/rate-limit";
import { conversationIdSchema, leadSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const THANKS = "Thanks, the team has your details and will contact you on that number.";

/** The contact form shown after a handoff. It doesn't depend on Claude. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request)) return Response.json({ error: "Forbidden" }, { status: 403 });
  if (!(await allowRequestFromIp(request))) {
    return Response.json({ error: "Please wait a few minutes and try again." }, { status: 429 });
  }

  const id = conversationIdSchema.safeParse((await params).id);
  if (!id.success || !(await getConversation(id.data))) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const lead = leadSchema.safeParse(await request.json().catch(() => null));
  if (!lead.success) {
    return Response.json({ error: lead.error.issues[0]?.message ?? "Please check your details." }, { status: 400 });
  }

  const reply = await transaction(async (tx) => {
    const { confirmationQueued } = await saveLead(tx, id.data, lead.data, "form");
    const text = confirmationQueued ? `${THANKS} A confirmation email is on its way to ${lead.data.email}.` : THANKS;
    await appendFixedReply(tx, id.data, text);
    return text;
  });
  await deliverDueNotifications().catch(console.error);
  return Response.json({ reply });
}
