# Community Connector Agent

## Original Prompt
> clone this in a new folder and run it https://github.com/whatslocal2-star/community-connector-agent

---

## Checkpoint 1 — Initial clone and run
Cloned repo to `~/community-connector-agent`. Project is a Netlify serverless app — a chat-based onboarding agent backed by OpenAI (`gpt-4o-mini`). Uses Telnyx for SMS and Netlify Blobs for conversation history. Installed deps, started local dev server via `netlify dev`, confirmed live at `http://localhost:8888`. Original prompt only supported vendor and shopper member types.

---

## Checkpoint 2 — Artist member type
Added **artist** as a third member type. Flow collects: discipline, preferred venue/event types, portfolio link, city/travel radius. Agent matches artists with venues and upcoming events. Header updated to "Vendors · Shoppers · Artists".

---

## Checkpoint 3 — Community organizer member type
Added **community organizer** as a fourth member type. Flow collects: cause/community focus, impact goals and what they need most, who they want to connect with (artists, businesses, volunteers, other orgs), and an org link. Agent matches them across all member types.

---

## Checkpoint 4 — Influencer member type
Added **influencer** as a fifth member type. Flow collects: content niche, platforms and audience size (micro-influencers welcome), partnership preferences (affiliate, sponsored posts, endorsements, ambassador, event coverage, takeovers), and a profile link. Agent matches with local businesses seeking social media growth.

---

## Checkpoint 5 — Cross-member discovery and anonymous people-nearby matching
Added a social/discovery layer across all types:
- **Shoppers**: collect neighborhood + a short personal note; anonymous proximity matching — both sides stay hidden until each approves, then connected to chat through the platform
- **Artists**: opt-in to be discoverable by other artists (collabs/features) and local businesses (partnerships)
- **Community organizers**: opt-in to discover and connect with other communities for co-hosting and cross-promotion
- **Vendors**: opt-in to be discoverable by other local businesses for cross-promos and referrals
- Added `ANONYMOUS DISCOVERY` section to system prompt explaining the consent-first, no-identifying-info flow

---

## Checkpoint 6 — AI-drafted business descriptions and event feed subscription
- **Vendors**: agent asks them to describe their business in their own words, drafts a polished blurb, iterates until they approve
- **Vendors + Artists**: both asked where they post events (Eventbrite, Facebook, Bandsintown, etc.) — platform subscribes, sends visibility suggestions, and reposts on its network

---

## Checkpoint 7 — Firestore storage with incremental profile extraction
Switched from Netlify Blobs (key-value, no querying) to **Firestore** for member profiles. Architecture:
- `lib/systemPrompt.js` — shared prompt for both chat and SMS functions
- `lib/profileTool.js` — JSON response parser (extracts `reply` + `profileUpdate` from each turn)
- `lib/db.js` — Firestore init (lazy singleton) + `loadConversation` / `saveMember` / `loadAllMembers`
- `chat.js` — accepts `sessionId` from frontend (UUID generated in `localStorage`), upserts profile per turn
- `sms.js` — keyed by phone number, loads/saves full conversation history + profile each turn
- `index.html` — generates UUID session ID on first visit, sends with every request

**Key design decision**: switched from OpenAI function calling (`tool_choice: auto` caused model to return tool call with no content) to `response_format: { type: "json_object" }` — model always returns `{ reply, profileUpdate }` in one shot.

**Firestore bug fix**: `set()` treats `"profile.memberType"` as a literal key name; `update()` treats it as a nested field path. Fixed to two-step write: `set({ merge: true })` for base fields, `update({ "profile.x": v })` for profile fields. Profile now correctly stored as a nested `profile` object.

**Firebase project**: `whatlocal-ab06e`
**Firestore collection**: `members/{sessionId|phoneNumber}`

---

## Checkpoint 8 — Netlify deployment
- Deployed to **https://community-connector-agent.netlify.app**
- Netlify site ID: `e5afa279-ebd1-456d-9195-ab1b1b77430a`
- Env vars set: `OPENAI_API_KEY`, `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `ADMIN_TOKEN`
- Firestore database created via Firebase CLI (`us-east1`)

---

## Checkpoint 9 — Superadmin dashboard
Built `/admin.html` — a token-protected dashboard for viewing all members:
- **API**: `netlify/functions/admin.js` — `GET /.netlify/functions/admin` with `Authorization: Bearer {ADMIN_TOKEN}`
- **UI features**: token login (sessionStorage), stats bar (totals + per-type + SMS/web split), filter tabs with live counts, free-text search across profile fields, table with type badge / key info / location / source / last active, click-to-expand profile modal with all fields and links
- **Admin URL**: https://community-connector-agent.netlify.app/admin.html
- **Admin token**: stored in Netlify env vars as `ADMIN_TOKEN`

---

## Current Stack
| Layer | Tech |
|---|---|
| Hosting | Netlify (functions + static) |
| Chat AI | OpenAI gpt-4o-mini, `response_format: json_object` |
| SMS | Telnyx (webhook → `sms.js`) |
| Database | Firestore (`whatlocal-ab06e`, `members` collection) |
| Auth (admin) | Bearer token via `ADMIN_TOKEN` env var |

## Member Types
`vendor` · `shopper` · `artist` · `organizer` · `influencer`

## Checkpoint 10 — Admin modal redesign (show all member data)
Rewrote the click-to-expand profile modal in `admin.html`:
- **Sectioned layout** replaces the old cramped 2-column grid: Account, type-specific profile, catch-all extras, raw JSON
- **Label/value rows** — full-width, readable, no truncation
- **Member ID** shown prominently with a copy button
- **Catch-all section** — iterates over all profile keys not in the explicit template so no data is ever silently dropped as new fields are added
- **Collapsible raw JSON** at the bottom for full data visibility
- Boolean fields styled (Yes ✓ / No), strings matching URL patterns auto-linked

---

## Key Files
```
index.html                          — Web chat UI
admin.html                          — Superadmin dashboard
netlify/functions/chat.js           — Web chat API
netlify/functions/sms.js            — SMS webhook (Telnyx)
netlify/functions/admin.js          — Admin members API
netlify/functions/lib/systemPrompt.js — Shared agent prompt
netlify/functions/lib/profileTool.js  — JSON response parser
netlify/functions/lib/db.js           — Firestore helpers
```
