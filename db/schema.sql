-- Safe to run repeatedly (npm run db:setup).

CREATE TABLE IF NOT EXISTS conversations (
  id             uuid PRIMARY KEY,
  status         text NOT NULL DEFAULT 'ai' CHECK (status IN ('ai', 'handed_off')),
  turn_count     integer NOT NULL DEFAULT 0,
  -- Stops two simultaneous messages from corrupting one conversation's history.
  busy_until     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
-- The AI provider the conversation started with: its history is stored in that format.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'claude';

-- content holds the exact message content of the conversation's AI provider and is only ever appended to.
CREATE TABLE IF NOT EXISTS messages (
  id              bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user', 'assistant')),
  content         jsonb NOT NULL,
  -- What people see. NULL for tool traffic that is never displayed.
  display_text    text,
  -- False for fixed messages Claude did not write or was not sent.
  in_prompt       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id, id);

CREATE TABLE IF NOT EXISTS leads (
  id              bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  phone           text NOT NULL,
  need            text NOT NULL,
  source          text NOT NULL CHECK (source IN ('assistant', 'form')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leads_created_idx ON leads (created_at DESC);
-- Optional. Used only for the customer's confirmation email.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS email text;

CREATE TABLE IF NOT EXISTS handoffs (
  id              bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
  trigger         text NOT NULL CHECK (trigger IN ('assistant', 'visitor', 'failure', 'limit')),
  reason          text NOT NULL,
  summary         text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Outbox: a notification is stored with the lead that caused it, then delivered
-- and retried, so a provider outage cannot lose an alert.
CREATE TABLE IF NOT EXISTS notifications (
  id              bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  channel         text NOT NULL,
  kind            text NOT NULL,
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_due_idx ON notifications (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS rate_limits (
  key          text NOT NULL,
  window_start timestamptz NOT NULL,
  count        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);
