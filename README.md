# AI Enquiry Assistant

A chat widget for small-business websites. It answers from the business's own FAQs, prices and services, saves every lead to Postgres, alerts the owner on WhatsApp or email, emails the customer a confirmation, and hands over to a person when it can't answer. A live "behind the scenes" panel shows each of those steps as it happens.

Built with Next.js and Postgres, and runs on either the Claude API or Google's Gemini API. The demo business, Larkspur Cycle Works, is fictional.

## What it does

- **Answers only from the business's information.** It's told never to estimate a price or policy that isn't stated.
- **Captures leads.** Name, phone and need are saved to Postgres, and the owner is alerted.
- **Confirms by email.** If the visitor gives an email address, which is optional, they get a "we've received your enquiry" email.
- **Shows its work.** Next to the chat, a panel lists what really happened, read from the database: lead saved, owner alerted (with delivery status), confirmation emailed, handed to a person. On phones it's a toggle in the chat header. Turn it off with `showActivityPanel` in `business/index.ts` for a real business.
- **Hands over to a person.** The AI stops replying in that conversation, and the owner gets an alert with a summary.
- **Never strands a visitor.** If Claude is down, declines or hits a limit, the visitor is handed over instead of seeing an error.

### When it hands over

| Trigger | What happens |
| --- | --- |
| The question isn't covered, or involves safety, a complaint or a refund | Claude calls the handoff tool |
| The visitor clicks "Talk to a person" | Handed over straight away, without calling Claude |
| Claude errors, declines or gets stuck | Handed over automatically |
| A conversation or daily limit is reached | Handed over automatically |

If the team has no way to reach the visitor, the widget shows a contact form. It doesn't depend on Claude, so it still works during an outage.

## Run it locally

Requires Node 22.9 or newer.

```bash
npm install
```

```bash
cp .env.example .env.local
```

In `.env.local`, set `ADMIN_PASSWORD`, `PG_POOL_MAX=1`, and the key for your AI provider (see [Choosing an AI provider](#choosing-an-ai-provider)). Then, in one terminal, start a local Postgres that needs no installation:

```bash
npm run db:local
```

In a second terminal:

```bash
npm run db:setup
```

```bash
npm run dev
```

- Site: http://localhost:3000
- Lead inbox: http://localhost:3000/admin (any username, plus your `ADMIN_PASSWORD`)

**No API key yet?** Run `npm run fake-claude`, and set `ANTHROPIC_BASE_URL=http://127.0.0.1:4010` and any value for `ANTHROPIC_API_KEY`. Its replies are scripted, so it's useful for trying the flows but says nothing about real answer quality. Remove `ANTHROPIC_BASE_URL` to use real Claude.

## Choosing an AI provider

Set `AI_PROVIDER` in `.env.local`. Each chat stays on the provider it started with, because its saved history is in that provider's format.

| | Claude (`AI_PROVIDER=claude`) | Gemini (`AI_PROVIDER=gemini`) |
| --- | --- | --- |
| Key | `ANTHROPIC_API_KEY` from the Claude Console | `GEMINI_API_KEY` from aistudio.google.com/app/apikey |
| Model setting | `CLAUDE_MODEL` (default `claude-opus-5-5`) | `GEMINI_MODEL` (default `gemini-3.5-flash-lite`) |
| Cost | Paid. `claude-haiku-5-5` is the cheapest | Free tier available, with low rate limits |
| Privacy | Not used for training by default | On the free tier, Google may use chats to improve its products |

The chat window tells visitors which provider replies, including Google's free-tier data use.

Gemini's free tier allows only a few requests a minute. Busy moments are retried briefly, then the visitor is handed to a person rather than shown an error.

## Use it for another business

Edit [business/index.ts](business/index.ts). The website and the assistant both read from that file, so the prices on the page and in the chat can't drift apart. Then update the suggested questions (`STARTERS`) and greeting in [ChatWidget.tsx](src/components/ChatWidget.tsx).

## Owner alerts

Set `NOTIFY_CHANNELS` to any of `email`, `whatsapp` and `log`, separated by commas.

Alerts are stored in the same database transaction as the lead, then delivered. Failures retry up to six attempts, on the next site activity or the daily job in [vercel.json](vercel.json), and any failure shows in the inbox.

**Email:** create a [Resend](https://resend.com) account, verify your sending domain, and fill in the `RESEND_` and `NOTIFY_EMAIL_` values.

**Customer confirmations:** set `CUSTOMER_CONFIRMATIONS=email` to send them through Resend. Your sending domain must be verified with Resend before it will deliver to visitors' addresses. Because anyone can type any address into a chat, the email is fixed text with nothing the visitor wrote in it, each chat sends at most one, and each address gets at most three a day.

**WhatsApp:** this needs a Meta WhatsApp Business account. Outside a 24-hour customer-service window, Meta only delivers pre-approved templates, and an owner alert usually falls outside it. Submit a template named `enquiry_alert` in the Utility category with this body:

```text
{{1}}
Name: {{2}}
Phone: {{3}}
Need: {{4}}
Open: {{5}}
```

Then fill in the `WHATSAPP_` values. Check Meta's changelog for the current API version.

## Deploy

1. Create a hosted Postgres database, such as Neon or Supabase.
2. Run `npm run db:setup` with `DATABASE_URL` pointing at it.
3. Deploy to Vercel, and add the environment variables from `.env.example`. Leave `PG_POOL_MAX` empty, and add `CRON_SECRET` and `IP_HASH_SALT`.
4. Set `PUBLIC_SITE_URL` to the live address.

The daily job suits Vercel's Hobby plan. On a paid plan, run it more often so failed alerts retry sooner when the site is quiet.

## Costs and abuse limits

Every Claude call is capped, and limits are stored in Postgres so they hold across serverless instances: 20 requests per IP per 10 minutes, 40 turns per conversation and 500 AI turns per day. Change them in `.env.local`. Also set a spending limit in the Claude Console.

`CLAUDE_MODEL` defaults to `claude-opus-5-5`. `claude-sonnet-5-5` and `claude-haiku-5-5` cost less per token, so try them against your own questions before switching.

Requests to models other than Haiku opt in to Anthropic's server-side refusal fallback, which retries a declined request on another model. To remove it, delete the `fallback` setting in [chat.ts](src/lib/chat.ts).

## Security and privacy

- The API key stays on the server, and conversation history is stored server-side, so a browser can't forge earlier messages.
- Claude's tools act only on the current conversation, whose ID comes from the server.
- A lead's phone number must appear in what the visitor actually wrote, so an invented number can't be saved.
- Visitor text is escaped in email alerts, and rendered as plain text in the widget and inbox.
- Only salted hashes of IP addresses are stored.

Before using this for a real business, add a privacy policy and decide how long to keep leads and transcripts. Nothing deletes them automatically.

## Tests

```bash
npm test
```

Tests use an in-memory Postgres and the fake Claude server, so they cost nothing. They cover the plumbing, not the quality of Claude's answers.

## Not included

- The owner can't reply inside the widget. They follow up by phone or WhatsApp using the number captured.
- Visitors can't book directly, since the assistant doesn't connect to a calendar.

## How it fits together

```text
business/index.ts      Business facts, used by the site and the assistant
db/schema.sql          Conversations, messages, leads, handoffs, alerts, limits
src/lib/prompt.ts      The assistant's instructions
src/lib/tools.ts       save_lead and hand_off_to_human
src/lib/chat.ts        One visitor message: AI, tools, failure handling
src/lib/providers/     Claude and Gemini behind one interface
src/lib/notify.ts      Stored alerts, customer confirmations, email, WhatsApp and retries
src/lib/activity.ts    The behind-the-scenes feed, built from the database
src/components/        The chat widget and activity panel
src/app/admin/         The password-protected lead inbox
```
