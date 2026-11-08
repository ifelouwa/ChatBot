import { handOffWithFixedReply } from "@/lib/chat";
import { createConversation, getConversation } from "@/lib/conversations";
import { deliverDueNotifications } from "@/lib/notify";
import { allowRequestFromIp, isSameOrigin } from "@/lib/rate-limit";
import { conversationIdSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The "Talk to a person" button. It works even if Claude is down. "new" starts a conversation. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request)) return Response.json({ error: "Forbidden" }, { status: 403 });
  if (!(await allowRequestFromIp(request))) {
    return Response.json({ error: "Please wait a few minutes and try again." }, { status: 429 });
  }

  const rawId = (await params).id;
  let conversationId: string;
  if (rawId === "new") {
    conversationId = (await createConversation()).id;
  } else {
    const id = conversationIdSchema.safeParse(rawId);
    if (!id.success || !(await getConversation(id.data))) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    conversationId = id.data;
  }

  const { reply, contactRequired } = await handOffWithFixedReply(conversationId, {
    trigger: "visitor",
    reason: "The visitor asked to talk to a person",
  });
  await deliverDueNotifications().catch(console.error);
  return Response.json({ conversationId, reply, contactRequired });
}
