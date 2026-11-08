import { getConversation, getLead, loadDisplayMessages } from "@/lib/conversations";
import { db } from "@/lib/db";
import { conversationIdSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Restores the chat after a page change. The random ID is the access key. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = conversationIdSchema.safeParse((await params).id);
  if (!id.success) return Response.json({ error: "Not found" }, { status: 404 });

  const conversation = await getConversation(id.data);
  if (!conversation) return Response.json({ error: "Not found" }, { status: 404 });

  const [messages, lead] = await Promise.all([
    loadDisplayMessages(db(), id.data),
    getLead(db(), id.data),
  ]);
  return Response.json({
    status: conversation.status,
    contactRequired: conversation.status === "handed_off" && !lead,
    messages: messages.map(({ id: messageId, role, text }) => ({ id: messageId, role, text })),
  });
}
