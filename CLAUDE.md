# Community Connector Agent

## What This Is
AI-driven community onboarding agent that profiles local members (vendors, shoppers, artists, organizers, influencers) via web chat or SMS, stores profiles in Firestore, enriches them from external sources, enables vector similarity matching via Pinecone, and harvests events from subscribed channels. Hosted on Netlify with Trigger.dev for scheduled jobs.

This project serves as the **signup + data layer** for the Community Marketplace (`/Users/xen/Desktop/dev/community-marketplace`) — a public Next.js app that lets anyone browse and discover onboarded profiles and community events.

## Architecture

**Request flow (per chat turn):**
1. User message arrives (web POST to `/functions/chat` or Telnyx webhook to `/functions/sms`)
2. Load conversation history from Firestore by `sessionId` (web) or phone number (SMS)
3. Append message → call OpenAI `gpt-4o-mini` with system prompt + history, `response_format: json_object`
4. Parse `{ reply, profileUpdate }` from response
5. Save member doc (upsert) + history to Firestore
6. Embed profile text → upsert to Pinecone
7. Post-save pipeline (fire-and-forget, non-blocking):
   a. **Subscriptions** — if `eventPostingPlatforms` captured, create subscription records in subcollection
   b. **Enrichment** — if a URL captured and not yet enriched, scrape website (Jina Reader) + Google Places → GPT extraction → merge new fields into profile
   c. **ProLocalIQ sync** — if name + email + memberType present and not yet synced, POST to prolocaliq
8. Return `reply` to client

**Event harvest (Trigger.dev cron — daily 8am):**
1. Query all members with active subscriptions
2. For each subscription, scrape the channel URL via Jina Reader
3. Send content to GPT to detect events and reword in community-first voice
4. Save event suggestions to `eventSuggestions` collection with status "pending"
5. Admin reviews/approves via `event-suggestions` endpoint

**Key files:**
| File | Purpose |
|------|---------|
| `index.html` | Web chat UI; generates `cc_session_id` UUID in localStorage; dev mode persona switcher |
| `admin.html` | Superadmin dashboard — all members, search, profile modal |
| `netlify/functions/chat.js` | Web chat handler + post-save pipeline |
| `netlify/functions/sms.js` | Telnyx webhook → SMS conversation |
| `netlify/functions/admin.js` | Member list API (bearer token) |
| `netlify/functions/matches.js` | Pinecone similarity query (bearer token) |
| `netlify/functions/enrich.js` | Manual profile enrichment endpoint (bearer token) |
| `netlify/functions/subscriptions.js` | List active subscriptions (bearer token) |
| `netlify/functions/event-suggestions.js` | List/approve/reject event suggestions (bearer token) |
| `netlify/functions/marketplace-members.js` | Public member list API — filterable by type/city, strips phone |
| `netlify/functions/marketplace-member.js` | Public single member profile by ID |
| `netlify/functions/marketplace-events.js` | Public approved events feed for marketplace |
| `netlify/functions/search.js` | Public unified search — GET `?q=...` or POST `{query, filters, excludes}` — same function for search bar + chat agent |
| `netlify/functions/lib/search.js` | Hybrid search: GPT intent parse → Pinecone semantic + in-memory hard filters |
| `netlify/functions/lib/searchIntent.js` | GPT NL → `{semantic, filters, excludes, intent}` parser |
| `netlify/functions/lib/recommend.js` | First-recommendation pipeline: search → top 3 → matchLog per candidate → natural blurb appended to reply |
| `netlify/functions/backfill-locations.js` | Admin: parse googleMapsUrl → lat/lng for members missing coords |
| `netlify/functions/patch-member.js` | Admin: POST `{id, fields}` to set arbitrary profile fields on any member |
| `netlify/functions/match-log.js` | Admin: GET/POST `matchLogs` — record intros/recommendations made to a member |
| `netlify/functions/claim-profile.js` | Admin: POST `{unclaimedId, claimedBy?, fields?}` — flip a harvested profile to `claimed` |
| `netlify/functions/lib/matchLog.js` | Firestore CRUD for `matchLogs` collection |
| `netlify/functions/lib/extractOutcome.js` | GPT outcome extractor — turns NL feedback into structured signal |
| `netlify/functions/lib/parseLocation.js` | Extracts lat/lng from Google Maps URLs (all formats + short links) |
| `netlify/functions/lib/taxonomy.js` | Canonical category/subcategory taxonomy + `TAXONOMY_PROMPT` for system prompt |
| `netlify/functions/lib/systemPrompt.js` | Shared onboarding prompt (flow + schema rules) |
| `netlify/functions/lib/db.js` | Firestore lazy init + member/subscription CRUD |
| `netlify/functions/lib/vectorSearch.js` | OpenAI embedding + Pinecone upsert/query |
| `netlify/functions/lib/profileTool.js` | JSON parse helper with fallback |
| `netlify/functions/lib/enrich.js` | Jina Reader scraping, Google Places API, GPT profile extraction |
| `netlify/functions/lib/subscriptions.js` | Builds subscription records from captured profile fields |
| `netlify/functions/lib/events.js` | Event suggestion CRUD for Firestore |
| `netlify/functions/lib/syncToProlocaliq.js` | ProLocalIQ account sync |
| `trigger.config.ts` | Trigger.dev project config |
| `trigger/harvest-events.ts` | Daily cron job — scrape subscribed channels, detect + reword events |
| `trigger/followup-intros.ts` | Hourly cron — send 48h follow-up on pending matchLogs, route reply through `extractOutcome` |
| `trigger/harvest-oakland.ts` | Weekly cron — harvest Oakland businesses from Google Places, GPT-enrich, store as `status:"unclaimed"` |

**Firestore collections:**

`members/{sessionId|phone}` — main member documents
```
profile (flat object — no nested objects allowed)
  memberType: "vendor" | "shopper" | "artist" | "organizer" | "influencer"
  interests, goals, painPoints, dislikes (arrays)
  eventPostingPlatforms (array — e.g. ["instagram", "eventbrite", "website"])
  city, neighborhood, vibe, notes, personalNote, approvedBlurb, ...
  enrichedAt (ISO string — set after first enrichment)
  prolocaliqSynced, prolocaliqAccountId
history: [{ role, content }]
lastActiveAt, source ("web" | "sms"), phone (SMS only)
```

`members/{id}/subscriptions/{platform}` — event source subscriptions
```
type: "instagram" | "eventbrite" | "website" | "facebook" | ...
handle, url
active: true
lastCheckedAt, createdAt
```

**Unclaimed profiles** — harvested businesses live in `members` with `source: "google_places_harvest"` and `status: "unclaimed"`. Doc id is `gp_<place_id>`. Pinecone metadata sets `unclaimed: true` so search can include or exclude them. Claim via `/claim-profile` (admin).

`matchLogs/{id}` — recorded intros/recommendations + outcome feedback
```
memberId, memberName
matchedMemberId, matchedMemberName
reason (why this match was suggested)
channel: "sms" | "web"
status: "pending" | "followed_up" | "completed"
introducedAt, followUpSentAt, outcomeReceivedAt
followUpText (what the bot said)
outcomeRaw (raw NL reply)
outcome: { attended, sentiment, reasons_positive[], reasons_negative[], would_repeat, implicit_profile_updates, summary }
```

`eventSuggestions/{id}` — harvested event suggestions
```
memberId, memberName
source: { platform, url }
title, date, time, location, description
originalExcerpt, reworded
status: "pending" | "approved" | "rejected"
rejectionReason ("not_local" | "too_promotional" | "already_posted" | "wrong_vibe" | "low_quality" | "duplicate" | "other")
rejectionNote (free-text optional)
createdAt, updatedAt
```

**Write strategy:** `set({ merge: true })` for top-level fields, then `update({ "profile.fieldName": value })` for profile fields (dot-notation = Firestore path, not literal key).

## Key Conventions

- **Model always returns JSON** `{ reply, profileUpdate }` — not function calling. If parse fails, treat whole response as `reply`, `profileUpdate = null`.
- **Profile fields are strictly flat** — no nested objects inside `profile`. Canonical field names: `interests`, `dietaryRestrictions`, `dislikes`, `vibe`, `goals`, `painPoints`, `notes`, `eventPostingPlatforms`.
- **Every turn captures all context** revealed — direct answers, asides, personality, specific names/URLs. Merge into existing profile, never duplicate facts.
- **Enrichment only fills gaps** — never overwrites user-provided data. Checks `member.profile[k]` before writing each extracted field.
- **SMS prompt is identical to web** except "keep responses SHORT — 1-3 sentences max". History capped at 20 messages.
- **Anonymous discovery** is a feature but not advertised — only explain if user explicitly asks.
- **Vector metadata** stores only `memberType` + `onboardingComplete`; full profile goes into embedding text.
- **Admin auth:** Bearer token (`ADMIN_TOKEN`) checked on `/admin`, `/matches`, `/enrich`, `/subscriptions`, and `/event-suggestions` endpoints.
- **Marketplace endpoints are public** — `marketplace-members`, `marketplace-member`, `marketplace-events` require no auth. `phone` field stripped before returning.
- **Location capture:** vendors/organizers asked for Google Maps link → saved as `googleMapsUrl` → `parseLocation.js` extracts `latitude`/`longitude` in background post-save. Supports all URL formats + `maps.app.goo.gl` short links. Run `backfill-locations` (admin) to parse existing records missing coords.

## Environment Variables (Netlify)
`OPENAI_API_KEY`, `FIREBASE_PROJECT_ID` (`whatlocal-ab06e`), `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` (escaped `\\n`), `ADMIN_TOKEN`, `TELNYX_API_KEY`, `TELNYX_FROM_NUMBER`, `PINECONE_API_KEY`, `PINECONE_INDEX_NAME` (default: `community-members`)

**Profile enrichment:**
- `GOOGLE_PLACES_API_KEY` — Google Places API key for business lookups (optional; enrichment works without it using website-only scraping via Jina Reader)

**ProLocalIQ sync:**
- `PROLOCALIQ_URL` — base URL of the prolocaliq Express server (e.g. `https://prolocaliq.com`)
- `CC_SYNC_TOKEN` — shared secret; must also be set on prolocaliq as `CC_SYNC_TOKEN`

**Trigger.dev (set in Trigger.dev dashboard):**
- `TRIGGER_SECRET_KEY` — project API key
- Same `OPENAI_API_KEY`, `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` as Netlify

## Recent Decisions
- Enforce flat Firestore schema with merge behavior (no nested profile objects)
- Agent must confirm platform handles/URLs with user before saving; skip confirmation if already provided
- Admin dashboard shows location field with fallback for older records
- ProLocalIQ sync: vendor/artist/organizer → creates business + businessAccount; shopper/influencer → invite_pending
- Profile enrichment scrapes via Jina Reader (free, no key) + Google Places API; only fills empty fields
- Event subscriptions: `eventPostingPlatforms` captured during onboarding → subscription subcollection records
- Trigger.dev daily harvest at 8am: scrape subscribed channels → GPT event detection → reworded suggestions saved as "pending" for admin review before reposting
- Marketplace launched: public Next.js app at `/Users/xen/Desktop/dev/community-marketplace` reads from 3 new public Netlify functions; all profiles live (no opt-in flag)
- Marketplace map view: grid/map toggle on browse page; colored dots by member type (Leaflet + OpenStreetMap); locate-me button with blinking user dot
- Member profile pages show mini map + "Open in Google Maps" link when coords present; `eventSuggestions` queries filter in-memory (no composite index required)
- Category/subcategory taxonomy: GPT auto-assigns from canonical taxonomy during onboarding; marketplace has 3-row filter (type → category → subcategory pills); shown on cards and profile headers
- `patch-member` admin endpoint: POST `{id, fields}` to manually set any profile fields (used for backfills)
- Marketplace profile pages show all social channels/contacts captured during onboarding: hardcoded support for Instagram, TikTok, Twitter/X, Threads, YouTube, LinkedIn, Spotify, SoundCloud, Facebook, Eventbrite, Bandsintown, Songkick, Meetup, Pinterest; plus a dynamic catch-all that auto-renders any unknown `*Handle` or `*Url` field with a generic link icon
