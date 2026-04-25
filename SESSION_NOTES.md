# Community Connector Agent — Session Notes

## What we built

A Netlify-hosted chat + SMS onboarding agent that asks new users if they're a **vendor** or **shopper**, then collects relevant info to set up their profile/preferences.

---

## File structure

```
agent/
├── index.html                   # Chat UI (green theme, bubble messages)
├── netlify.toml                 # publish=".", functions="netlify/functions", esbuild
├── package.json                 # openai ^4.78.0, @netlify/blobs ^8.1.0
└── netlify/functions/
    ├── chat.js                  # Web chat endpoint → OpenAI
    └── sms.js                   # Telnyx inbound SMS webhook → OpenAI
```

---

## Tech stack

| Layer | Choice |
|---|---|
| LLM | OpenAI `gpt-4o-mini` |
| SMS | Telnyx (inbound webhook + outbound REST API) |
| Conversation state (SMS) | Netlify Blobs, keyed by phone number |
| Hosting | Netlify (static + serverless functions) |

---

## Environment variables (set in Netlify dashboard)

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | OpenAI secret key |
| `TELNYX_API_KEY` | Telnyx API key (portal → API Keys) |
| `TELNYX_FROM_NUMBER` | Your Telnyx phone number e.g. `+15551234567` |

---

## Conversation flow (system prompt, same in both functions)

1. **Greeting** — on first message, ask: vendor/business or shopper?
2. **Vendor path** — ask for a business link (Google Maps, Shopify, website, Instagram, etc.), then ask what they want to share with the community (deals, events, announcements)
3. **Shopper path** — ask what they're into, then how they want to stay connected (notifications, weekly digest, browsing)
- Responses kept short (1–3 sentences for SMS, ~512 tokens for web)

---

## How chat.js works

- `POST /.netlify/functions/chat`
- Body: `{ messages: [{role, content}, ...] }` — full history sent by the browser
- Prepends system prompt, calls `gpt-4o-mini`, returns `{ reply: "..." }`

## How sms.js works

- Telnyx sends `POST` to `/.netlify/functions/sms` on inbound message
- Reads `data.event_type === "message.received"`, extracts `from` number + text
- Loads history from Netlify Blobs (key = phone number), appends user message
- Calls `gpt-4o-mini` (max 300 tokens), appends reply, saves history back
- Sends reply via `POST https://api.telnyx.com/v2/messages`
- Always returns HTTP 200 to Telnyx (even on error, with a fallback reply attempt)
- History capped at 20 messages

---

## Telnyx webhook setup

1. Telnyx portal → **Messaging → Messaging Profiles** → your profile → **Inbound Settings**
2. Webhook URL: `https://your-site.netlify.app/.netlify/functions/sms`
3. Assign your phone number to that messaging profile

---

## Deploy

```bash
npm install -g netlify-cli
netlify deploy --prod
```
Or drag the `agent/` folder to app.netlify.com/drop.

---

## Next steps / ideas

- Add Telnyx webhook signature verification (`x-telnyx-signature`) for security
- Store completed profiles to a database (Supabase, PlanetScale, etc.)
- Add a reset keyword (e.g. "restart") to clear a user's SMS history
- Scrape vendor links automatically when they're submitted
- Connect shopper preferences to vendor profiles for matchmaking
