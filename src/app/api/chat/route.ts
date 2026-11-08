import { handleVisitorMessage, type ChatEvent } from "@/lib/chat";
import { claimTurn, createConversation, getConversation, releaseTurn } from "@/lib/conversations";
import { deliverDueNotifications } from "@/lib/notify";
import { allowRequestFromIp, isSameOrigin } from "@/lib/rate-limit";
import { chatRequestSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "Forbidden" }, { status: 403 });

  const body = chatRequestSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return Response.json({ error: "Please send a message of up to 2000 characters." }, { status: 400 });
  }
  if (!(await allowRequestFromIp(request))) {
    return Response.json({ error: "That's a lot of messages. Please wait a few minutes." }, { status: 429 });
  }

  // An unknown ID gets a new conversation, so IDs can't be invented by clients.
  let conversation = body.data.conversationId ? await claimTurn(body.data.conversationId) : null;
  if (!conversation) {
    if (body.data.conversationId && (await isBusy(body.data.conversationId))) {
      return Response.json({ error: "Please wait for the current reply to finish." }, { status: 409 });
    }
    const created = await createConversation();
    conversation = await claimTurn(created.id);
  }
  const claimed = conversation!;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: ChatEvent) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // The visitor left. Keep going so the reply and any lead are still saved.
        }
      };
      emit({ type: "conversation", id: claimed.id });
      try {
        await handleVisitorMessage(claimed, body.data.message, emit);
      } catch (error) {
        console.error("Chat turn failed:", error);
      } finally {
        await releaseTurn(claimed.id).catch(console.error);
      }
      emit({ type: "done" });
      // Holding the stream open keeps a serverless function alive while alerts send.
      await deliverDueNotifications().catch(console.error);
      try {
        controller.close();
      } catch {
        // Already closed by the visitor leaving.
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}

/** A claim failed, so the conversation is either mid-reply or doesn't exist. */
async function isBusy(id: string): Promise<boolean> {
  return (await getConversation(id)) !== null;
}
