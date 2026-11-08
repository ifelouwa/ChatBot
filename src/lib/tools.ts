import { CONTACT_REQUEST, HANDOFF_MESSAGE, loadDisplayMessages, saveLead, startHandoff } from "./conversations";
import type { Queryable } from "./db";
import type { ToolCall, ToolDefinition, ToolResult } from "./providers";
import { handoffSchema, leadSchema, phoneDigits } from "./validation";

/** Written once in JSON Schema. Each provider converts it to its own format. */
export const TOOLS: ToolDefinition[] = [
  {
    name: "save_lead",
    description:
      "Saves the visitor's contact details so the team can follow up, and alerts the owner. Call once you have their name, phone number and what they need. Call again if they correct a detail.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The visitor's name, as they gave it." },
        phone: { type: "string", description: "The visitor's phone number, exactly as they gave it." },
        need: { type: "string", description: "One sentence on what they want, in plain words." },
        email: {
          type: "string",
          description: "Optional. The visitor's email address, exactly as they gave it, if they want a confirmation email.",
        },
      },
      required: ["name", "phone", "need"],
      additionalProperties: false,
    },
  },
  {
    name: "hand_off_to_human",
    description:
      "Passes the conversation to a person at the business and alerts the owner. You stop handling this conversation afterwards, so write your closing message in the same turn.",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Short reason, such as: Question about frame damage." },
        summary: {
          type: "string",
          description: "Two sentences for the person taking over: who this is, what they want and what was said.",
        },
      },
      required: ["reason", "summary"],
      additionalProperties: false,
    },
  },
];

export type ToolOutcome = {
  result: ToolResult;
  /** Set when the conversation was handed over by this call. */
  handedOff?: { contactRequired: boolean };
};

/**
 * Runs one tool call. conversationId comes from the server, never from the
 * model, so nothing in a chat can touch another conversation's data.
 */
export async function runTool(q: Queryable, conversationId: string, block: ToolCall): Promise<ToolOutcome> {
  const errorResult = (_id: string, content: string): ToolOutcome => ({
    result: { id: block.id, name: block.name, content, isError: true },
  });
  const okResult = (_id: string, content: string): ToolOutcome => ({
    result: { id: block.id, name: block.name, content, isError: false },
  });

  switch (block.name) {
    case "save_lead": {
      const parsed = leadSchema.safeParse(block.input);
      if (!parsed.success) {
        return errorResult(block.id, `Not saved. ${parsed.error.issues.map((issue) => issue.message).join(". ")}`);
      }
      // Made-up details are worse than none, so they must appear in what the visitor wrote.
      const messages = await loadDisplayMessages(q, conversationId);
      const visitorText = messages.filter((m) => m.role === "user").map((m) => m.text);
      if (!visitorText.some((text) => phoneDigits(text).includes(phoneDigits(parsed.data.phone)))) {
        return errorResult(block.id, "Not saved. The visitor hasn't given this phone number. Ask them for it.");
      }
      const { email } = parsed.data;
      if (email && !visitorText.some((text) => text.toLowerCase().includes(email))) {
        return errorResult(
          block.id,
          "Not saved. The visitor hasn't given this email address. Save without it, or ask them for it.",
        );
      }
      const { confirmationQueued } = await saveLead(q, conversationId, parsed.data, "assistant");
      return okResult(
        block.id,
        "Saved, and the team has been told. Tell the visitor the team will contact them on that number. Don't promise a time." +
          (confirmationQueued ? ` Also tell them a confirmation email is on its way to ${email}.` : ""),
      );
    }

    case "hand_off_to_human": {
      const parsed = handoffSchema.safeParse(block.input);
      if (!parsed.success) {
        return errorResult(block.id, `Not handed over. Provide a short reason and a summary.`);
      }
      const { lead } = await startHandoff(q, conversationId, { trigger: "assistant", ...parsed.data });
      const contactRequired = !lead;
      return {
        ...okResult(
          block.id,
          contactRequired
            ? `Handed over. The chat now shows a contact form, because the team has no way to reach this visitor. Say roughly: "${HANDOFF_MESSAGE}${CONTACT_REQUEST}" Don't ask for the details in chat.`
            : `Handed over, and the team has this visitor's details. Say roughly: "${HANDOFF_MESSAGE}"`,
        ),
        handedOff: { contactRequired },
      };
    }

    default:
      return errorResult(block.id, `Unknown tool ${block.name}.`);
  }
}
