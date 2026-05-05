# Community Connector Agent

## What This Is
AI-driven community onboarding agent that profiles local members (vendors, shoppers, artists, organizers, influencers) via web chat or SMS, stores profiles in Firestore, and enables vector similarity matching via Pinecone. Hosted on Netlify.

## Architecture

**Request flow (per turn):**
1. User message arrives (web POST to `/functions/chat` or Telnyx webhook to `/functions/sms`)
2. Load conversation history from Firestore by `sessionId` (web) or phone number (SMS)
3. Append message → call OpenAI `gpt-4o-mini` with system prompt + history, `response_format: json_object`
4. Parse `{ reply, profileUpdate }` from response
5. Save member doc (upsert) + history to Firestore
6. Embed profile text → upsert to Pinecone
7. Return `reply` to client

**Key files:**
| File | Purpose |
|------|---------|
| `index.html` | Web chat UI; generates `cc_session_id` UUID in localStorage; dev mode persona switcher |
| `admin.html` | Superadmin dashboard — all members, search, profile modal |
| `netlify/functions/chat.js` | Web chat handler |
| `netlify/functions/sms.js` | Telnyx webhook → SMS conversation |
| `netlify/functions/admin.js` | Member list API (bearer token) |
| `netlify/functions/matches.js` | Pinecone similarity query (bearer token) |
| `netlify/functions/enrich.js` | Profile enrichment endpoint (bearer token) — scrapes web + Google Places |
| `netlify/functions/lib/enrich.js` | Enrichment logic: Jina Reader scraping, Google Places API, GPT extraction |
| `netlify/functions/lib/systemPrompt.js` | Shared onboarding prompt (flow + schema rules) |
| `netlify/functions/lib/db.js` | Firestore lazy init + CRUD |
| `netlify/functions/lib/vectorSearch.js` | OpenAI embedding + Pinecone upsert/query |
| `netlify/functions/lib/profileTool.js` | JSON parse helper with fallback |

**Firestore schema** (`members/{sessionId|phone}`)
```
profile (flat object — no nested objects allowed)
  memberType: "vendor" | "shopper" | "artist" | "organizer" | "influencer"
  interests, goals, painPoints, dislikes (arrays)
  city, neighborhood, vibe, notes, personalNote, approvedBlurb, ...
history: [{ role, content }]
lastActiveAt, source ("web" | "sms"), phone (SMS only)
```

**Write strategy:** `set({ merge: true })` for top-level fields, then `update({ "profile.fieldName": value })` for profile fields (dot-notation = Firestore path, not literal key).

## Key Conventions

- **Model always returns JSON** `{ reply, profileUpdate }` — not function calling. If parse fails, treat whole response as `reply`, `profileUpdate = null`.
- **Profile fields are strictly flat** — no nested objects inside `profile`. Canonical field names: `interests`, `dietaryRestrictions`, `dislikes`, `vibe`, `goals`, `painPoints`, `notes`.
- **Every turn captures all context** revealed — direct answers, asides, personality, specific names/URLs. Merge into existing profile, never duplicate facts.
- **SMS prompt is identical to web** except "keep responses SHORT — 1-3 sentences max". History capped at 20 messages.
- **Anonymous discovery** is a feature but not advertised — only explain if user explicitly asks.
- **Vector metadata** stores only `memberType` + `onboardingComplete`; full profile goes into embedding text.
- **Admin auth:** Bearer token (`ADMIN_TOKEN`) checked on `/admin` and `/matches` endpoints.

## Environment Variables (Netlify)
`OPENAI_API_KEY`, `FIREBASE_PROJECT_ID` (`whatlocal-ab06e`), `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` (escaped `\\n`), `ADMIN_TOKEN`, `TELNYX_API_KEY`, `TELNYX_FROM_NUMBER`, `PINECONE_API_KEY`, `PINECONE_INDEX_NAME` (default: `community-members`)

**Profile enrichment (set on Netlify):**
- `GOOGLE_PLACES_API_KEY` — Google Places API key for business lookups (optional; enrichment works without it using website-only scraping)

**ProLocalIQ sync (set on Netlify):**
- `PROLOCALIQ_URL` — base URL of the prolocaliq Express server (e.g. `https://prolocaliq.com`)
- `CC_SYNC_TOKEN` — shared secret; must also be set on prolocaliq as `CC_SYNC_TOKEN`

## Recent Decisions
- Enforce flat Firestore schema with merge behavior (no nested profile objects)
- Agent must confirm platform handles/URLs with user before saving; skip confirmation if already provided
- Admin dashboard shows location field with fallback for older records
- ProLocalIQ sync: after each save, if `name + email + memberType` all present and `prolocaliqSynced` is false, POST to `PROLOCALIQ_URL/api/integrations/community-connector/sync`. vendor/artist/organizer → creates business + businessAccount in prolocaliq. shopper/influencer → returns invite_pending (requires Google OAuth on prolocaliq side). Sets `prolocaliqSynced: true` + `prolocaliqAccountId` in Firestore on success.
- Profile enrichment: when a URL is captured during onboarding (websiteUrl, googleMapsUrl, etc.), background enrichment scrapes the site via Jina Reader + Google Places API, extracts structured fields via GPT, and merges them into the profile (only fills empty fields, never overwrites user-provided data). Also available as manual endpoint `POST /functions/enrich` (bearer token).
