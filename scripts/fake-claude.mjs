// A stand-in for the Claude and Gemini APIs, for tests and offline demos. It
// costs nothing, and its replies are scripted from keywords, so it proves the
// app's plumbing, not the quality of real answers. Point the app at it with
// ANTHROPIC_BASE_URL=http://127.0.0.1:4010 (any ANTHROPIC_API_KEY), or
// GEMINI_BASE_URL=http://127.0.0.1:4010 (any GEMINI_API_KEY).
import { createServer } from "node:http";

function toolUse(name, input) {
  return { type: "tool_use", id: `toolu_${Math.random().toString(36).slice(2, 14)}`, name, input };
}

function reply(request) {
  const last = request.messages.at(-1);
  const blocks = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
  const toolResult = blocks.find((block) => block.type === "tool_result");

  if (toolResult) {
    const result = String(toolResult.content);
    if (toolResult.is_error) return { content: [{ type: "text", text: "Sorry, could you check your phone number?" }] };
    const quoted = /Say roughly: "(.*?)"/.exec(result);
    const emailed = /confirmation email is on its way to (\S+?)\.$/.exec(result);
    const text = quoted
      ? quoted[1]
      : `Thanks, the team will contact you on that number.${emailed ? ` A confirmation email is on its way to ${emailed[1]}.` : ""}`;
    return { content: [{ type: "text", text }] };
  }

  const text = blocks.filter((block) => block.type === "text").at(-1)?.text ?? "";
  const lower = text.toLowerCase();
  if (lower.includes("simulate outage")) return { status: 500 };
  if (lower.includes("simulate refusal")) return { content: [], stop_reason: "refusal" };
  if (lower.includes("invented number")) {
    return { content: [toolUse("save_lead", { name: "Sam", phone: "555 999 0000", need: "A tune-up" })] };
  }
  if (lower.includes("invented email")) {
    return {
      content: [toolUse("save_lead", { name: "Sam", phone: "555 010 2030", need: "A tune-up", email: "made-up@example.com" })],
    };
  }
  const phone = /(\+?\d[\d\s().-]{6,}\d)/.exec(text);
  const email = /[^\s@,]+@[^\s@,]+\.[a-z]{2,}/i.exec(text);
  if (phone) {
    return {
      content: [
        { type: "text", text: "Let me note that down." },
        toolUse("save_lead", {
          name: "Sam",
          phone: phone[1],
          need: "A standard tune-up",
          ...(email ? { email: email[0] } : {}),
        }),
      ],
    };
  }
  if (lower.includes("crack") || lower.includes("person")) {
    return {
      content: [
        toolUse("hand_off_to_human", {
          reason: "Question about frame damage",
          summary: "Visitor reports a cracked frame and wants to know if it can be repaired.",
        }),
      ],
    };
  }
  if (lower.includes("book")) {
    return { content: [{ type: "text", text: "Happy to help. What's your name and phone number?" }] };
  }
  return { content: [{ type: "text", text: "A standard tune-up is $85 and takes about 2 working days." }] };
}

function sse(response, type, data) {
  response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

/**
 * Gemini's streamGenerateContent. Like the real API, it attaches thought
 * signatures and rejects a later request that doesn't send them back, so the
 * tests catch an app that alters stored replies.
 */
function handleGemini(parsed, response) {
  const geminiError = (code, status, message) => {
    response.writeHead(code, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code, message, status } }));
  };

  for (const content of parsed.contents) {
    if (content.role === "model" && content.parts.some((p) => p.functionCall) && !content.parts.some((p) => p.thoughtSignature)) {
      return geminiError(400, "INVALID_ARGUMENT", "Function call is missing a thought_signature");
    }
  }

  // Turns the Gemini request into the shape reply() understands.
  const last = parsed.contents.at(-1);
  const blocks = last.parts.map((part) =>
    part.functionResponse
      ? {
          type: "tool_result",
          content: part.functionResponse.response.result ?? part.functionResponse.response.error,
          is_error: Boolean(part.functionResponse.response.error),
        }
      : { type: "text", text: part.text ?? "" },
  );
  const scripted = reply({ messages: [{ role: "user", content: blocks }] });
  if (scripted.status) return geminiError(500, "INTERNAL", "Simulated outage");

  const chunk = (parts, extra = {}) =>
    response.write(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts }, index: 0, ...extra }] })}\r\n\r\n`);
  response.writeHead(200, { "content-type": "text/event-stream" });

  if (scripted.stop_reason === "refusal") {
    chunk([], { finishReason: "SAFETY" });
    return response.end();
  }
  // Hidden reasoning, which must never reach the visitor.
  chunk([{ text: "FAKE-HIDDEN-THOUGHT", thought: true }]);
  for (const block of scripted.content) {
    if (block.type === "text") {
      for (const word of block.text.match(/\S+\s*/g) ?? []) chunk([{ text: word }]);
    } else {
      chunk([{ functionCall: { name: block.name, args: block.input }, thoughtSignature: `sig-${block.id}` }]);
    }
  }
  // Real Gemini can deliver a signature on a final, empty text part.
  response.write(
    `data: ${JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text: "", thoughtSignature: "sig-final" }] }, finishReason: "STOP", index: 0 }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 },
    })}\r\n\r\n`,
  );
  response.end();
}

const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    const parsed = JSON.parse(body);
    if (request.url.includes(":streamGenerateContent")) return handleGemini(parsed, response);
    const scripted = reply(parsed);
    if (scripted.status) {
      response.writeHead(scripted.status, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "Simulated outage" } }));
      return;
    }
    const content = scripted.content;
    const hasTool = content.some((block) => block.type === "tool_use");
    const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

    response.writeHead(200, { "content-type": "text/event-stream" });
    sse(response, "message_start", {
      message: { id: "msg_fake", type: "message", role: "assistant", model: parsed.model, content: [], stop_reason: null, stop_sequence: null, usage },
    });
    content.forEach((block, index) => {
      if (block.type === "text") {
        sse(response, "content_block_start", { index, content_block: { type: "text", text: "" } });
        for (const word of block.text.match(/\S+\s*/g) ?? []) {
          sse(response, "content_block_delta", { index, delta: { type: "text_delta", text: word } });
        }
      } else {
        sse(response, "content_block_start", { index, content_block: { ...block, input: {} } });
        sse(response, "content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
      }
      sse(response, "content_block_stop", { index });
    });
    sse(response, "message_delta", {
      delta: { stop_reason: scripted.stop_reason ?? (hasTool ? "tool_use" : "end_turn"), stop_sequence: null },
      usage: { output_tokens: 20 },
    });
    sse(response, "message_stop", {});
    response.end();
  });
});

const port = Number(process.env.FAKE_CLAUDE_PORT ?? 4010);
server.listen(port, "127.0.0.1", () => console.log(`Fake Claude and Gemini on http://127.0.0.1:${port}`));
