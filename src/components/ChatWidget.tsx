"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ActivityList, type ActivityItem } from "./ActivityList";

type Message = { key: string; role: "user" | "assistant"; text: string };

type ServerEvent =
  | { type: "conversation"; id: string }
  | { type: "delta"; text: string }
  | { type: "reset" }
  | { type: "break" }
  | { type: "handoff"; contactRequired: boolean }
  | { type: "activity" }
  | { type: "done" };

const ACTIVITY_POLL_MS = 15_000;

const STORAGE_KEY = "enquiry-conversation-id";
const STARTERS = ["How much is a tune-up?", "Are you open today?", "I'd like to book a repair"];
const GREETING =
  "Hi, I'm the shop's AI assistant. Ask me about prices, repairs or opening hours, or I can get a person for you.";

let nextKey = 0;
const newKey = () => `local-${nextKey++}`;

// Browser storage can be blocked. The chat still works, it just won't survive a reload.
function readStoredId(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}
function storeId(id: string | null) {
  try {
    if (id) window.localStorage.setItem(STORAGE_KEY, id);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // See above.
  }
}

export function ChatWidget({
  title,
  showActivity,
  aiNotice,
}: {
  title: string;
  showActivity: boolean;
  aiNotice: string;
}) {
  const [open, setOpen] = useState(false);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  // Phones show one view at a time. Wide screens show both side by side.
  const [view, setView] = useState<"chat" | "activity">("chat");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [handedOff, setHandedOff] = useState(false);
  const [contactRequired, setContactRequired] = useState(false);
  const conversationId = useRef<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const restored = useRef(false);

  const refreshActivity = useCallback(async () => {
    const id = conversationId.current;
    if (!showActivity || !id) return;
    try {
      const response = await fetch(`/api/conversations/${id}/activity`);
      if (response.ok) setActivity((await response.json()).items);
    } catch {
      // The panel is a bonus. A failed refresh just leaves the last state showing.
    }
  }, [showActivity]);

  // Alerts that are still sending or retrying get checked again until they settle.
  const unsettled = activity.some((item) => item.status === "sending" || item.status === "retrying");
  useEffect(() => {
    if (!open || !unsettled) return;
    const timer = window.setInterval(refreshActivity, ACTIVITY_POLL_MS);
    return () => window.clearInterval(timer);
  }, [open, unsettled, refreshActivity]);

  // Restores an earlier chat the first time the panel opens.
  useEffect(() => {
    if (!open || restored.current) return;
    restored.current = true;
    const id = readStoredId();
    if (!id) return;
    fetch(`/api/conversations/${id}`)
      .then(async (response) => {
        if (!response.ok) {
          storeId(null);
          return;
        }
        const data = await response.json();
        conversationId.current = id;
        setMessages(data.messages.map((m: { id: string; role: Message["role"]; text: string }) => ({
          key: `server-${m.id}`,
          role: m.role,
          text: m.text,
        })));
        setHandedOff(data.status === "handed_off");
        setContactRequired(data.contactRequired);
        void refreshActivity();
      })
      .catch(() => {
        // Starting fresh is fine if the old chat can't be loaded.
      });
  }, [open, refreshActivity]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages, contactRequired, busy]);

  const appendAssistant = useCallback((text: string) => {
    setMessages((current) => [...current, { key: newKey(), role: "assistant", text }]);
  }, []);

  const adoptConversation = (id: string) => {
    conversationId.current = id;
    storeId(id);
  };

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setError(null);
    setBusy(true);
    setInput("");
    setMessages((current) => [...current, { key: newKey(), role: "user", text: message }]);

    // The bubble being streamed into. Null means the next text starts a new one.
    let streamingKey: string | null = null;
    const applyEvent = (event: ServerEvent) => {
      switch (event.type) {
        case "conversation":
          adoptConversation(event.id);
          break;
        case "delta": {
          const key: string = streamingKey ?? newKey();
          const isNew = streamingKey === null;
          streamingKey = key;
          setMessages((current) =>
            isNew
              ? [...current, { key, role: "assistant", text: event.text }]
              : current.map((m) => (m.key === key ? { ...m, text: m.text + event.text } : m)),
          );
          break;
        }
        case "reset": {
          const key = streamingKey;
          streamingKey = null;
          if (key) setMessages((current) => current.filter((m) => m.key !== key));
          break;
        }
        case "break":
          streamingKey = null;
          break;
        case "handoff":
          setHandedOff(true);
          setContactRequired(event.contactRequired);
          break;
        case "activity":
          void refreshActivity();
          break;
        case "done":
          break;
      }
    };

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: conversationId.current, message }),
      });
      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error ?? "The message didn't send. Please try again.");
      }
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) applyEvent(JSON.parse(line) as ServerEvent);
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The message didn't send. Please try again.");
    } finally {
      setBusy(false);
      inputRef.current?.focus();
      // The stream ends only after alerts are sent, so this shows their result.
      void refreshActivity();
    }
  }

  async function talkToPerson() {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const response = await fetch(`/api/conversations/${conversationId.current ?? "new"}/handoff`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "That didn't work. Please try again.");
      adoptConversation(data.conversationId);
      appendAssistant(data.reply);
      setHandedOff(true);
      setContactRequired(data.contactRequired);
      void refreshActivity();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That didn't work. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function submitContact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    setError(null);
    setBusy(true);
    try {
      const response = await fetch(`/api/conversations/${conversationId.current}/contact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.get("name"),
          phone: form.get("phone"),
          need: form.get("need"),
          email: form.get("email"),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Your details didn't send. Please try again.");
      appendAssistant(data.reply);
      setContactRequired(false);
      void refreshActivity();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Your details didn't send. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  function startOver() {
    storeId(null);
    conversationId.current = null;
    setMessages([]);
    setActivity([]);
    setView("chat");
    setHandedOff(false);
    setContactRequired(false);
    setError(null);
    inputRef.current?.focus();
  }

  function close() {
    setOpen(false);
    requestAnimationFrame(() => launcherRef.current?.focus());
  }

  if (!open) {
    return (
      <button ref={launcherRef} className="chat-launcher" onClick={() => setOpen(true)}>
        <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
        </svg>
        {title}
      </button>
    );
  }

  const lastIsUser = messages.at(-1)?.role === "user";

  return (
    <>
    {showActivity && (
      <aside className="activity-side" aria-label="Behind the scenes">
        <ActivityList items={activity} />
      </aside>
    )}
    <section
      className="chat-panel"
      role="dialog"
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
      }}
    >
      <div className="chat-header">
        <div>
          <div className="chat-title">{title}</div>
          <div className="chat-subtitle">{handedOff ? "Passed to the team" : "AI assistant. A person can take over."}</div>
        </div>
        <div className="chat-header-actions">
          {showActivity && (
            <button
              className="header-toggle"
              aria-pressed={view === "activity"}
              onClick={() => setView(view === "chat" ? "activity" : "chat")}
            >
              {view === "chat" ? `Behind the scenes${activity.length ? ` (${activity.length})` : ""}` : "Back to chat"}
            </button>
          )}
          <button className="icon-button" aria-label="Close chat" onClick={close}>
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 4L14 14M14 4L4 14" />
            </svg>
          </button>
        </div>
      </div>

      {showActivity && (
        <div className={`activity-inline ${view === "chat" ? "narrow-hidden" : ""}`}>
          <ActivityList items={activity} />
        </div>
      )}

      <div className={`chat-log ${view === "activity" ? "narrow-hidden" : ""}`} ref={logRef} role="log" aria-live="polite">
        <p className="chat-note">Details you share here go to the shop so they can reply to you. {aiNotice}</p>
        <div className="bubble bubble-assistant">{GREETING}</div>
        {messages.length === 0 && (
          <div className="chat-chips">
            {STARTERS.map((starter) => (
              <button className="chip" key={starter} onClick={() => send(starter)}>
                {starter}
              </button>
            ))}
          </div>
        )}
        {messages.map((message) => (
          <div className={`bubble bubble-${message.role}`} key={message.key}>
            {message.text}
          </div>
        ))}
        {busy && lastIsUser && <div className="bubble bubble-assistant bubble-typing">Typing…</div>}
      </div>

      {contactRequired && (
        <form className="contact-form" onSubmit={submitContact}>
          <strong>How can the team reach you?</strong>
          <label>
            Name
            <input name="name" required maxLength={100} autoComplete="name" />
          </label>
          <label>
            Phone
            <input name="phone" type="tel" required maxLength={25} autoComplete="tel" />
          </label>
          <label>
            What do you need?
            <input name="need" required maxLength={500} />
          </label>
          <label>
            Email for a confirmation (optional)
            <input name="email" type="email" maxLength={254} autoComplete="email" />
          </label>
          <button className="primary-button" disabled={busy}>
            Send my details
          </button>
        </form>
      )}

      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}

      <div className="chat-footer">
        {!contactRequired && (
          <form
            className="chat-compose"
            onSubmit={(event) => {
              event.preventDefault();
              void send(input);
            }}
          >
            <label className="visually-hidden" htmlFor="chat-input">
              Message
            </label>
            <input
              id="chat-input"
              ref={inputRef}
              value={input}
              maxLength={2000}
              autoComplete="off"
              placeholder={handedOff ? "Add a message for the team" : "Ask about prices, repairs, hours"}
              onChange={(event) => setInput(event.target.value)}
            />
            <button className="primary-button send-button" aria-label="Send message" disabled={busy || !input.trim()}>
              <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 15V3M4 8L9 3L14 8" />
              </svg>
            </button>
          </form>
        )}
        <div className="chat-links">
          {handedOff ? (
            <button className="text-button" onClick={startOver}>
              Start a new chat
            </button>
          ) : (
            <button className="text-button" onClick={talkToPerson} disabled={busy}>
              Talk to a person
            </button>
          )}
        </div>
      </div>
    </section>
    </>
  );
}
