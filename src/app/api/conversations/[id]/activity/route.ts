import { loadActivity } from "@/lib/activity";
import { getConversation } from "@/lib/conversations";
import { db } from "@/lib/db";
import { conversationIdSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Feeds the behind-the-scenes panel. The random conversation ID is the access key. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = conversationIdSchema.safeParse((await params).id);
  if (!id.success || !(await getConversation(id.data))) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  return Response.json({ items: await loadActivity(db(), id.data) });
}
