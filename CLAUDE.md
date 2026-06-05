# Community Connector Agent

## What This Is
AI-driven community onboarding agent that profiles local members (vendors, shoppers, artists, organizers, influencers) via web chat or SMS, stores profiles in Firestore, enriches them from external sources, enables vector similarity matching via Pinecone, and harvests events from subscribed channels. Hosted on Netlify with Trigger.dev for scheduled jobs.

This project serves as the **signup + data layer** for the Community Marketplace (`/Users/xen/Desktop/dev/community-marketplace`) — a public Next.js app that lets anyone browse and discover onboarded profiles and community events.

## Architecture

**Request flow (per chat turn):**
1. User message arrives (web POST to `/functions/chat` or Telnyx webhook to `/functions/sms`)
2. **Outcome short-circuit:** if this member has a matchLog with `status:"followed_up"` (loadAwaitingOutcome), treat the incoming message as feedback on a past intro — route through `extractOutcome` (GPT → structured signal), call `recordOutcome`, merge any `implicit_profile_updates` into the profile, re-embed, send a thank-you ack, and return. Skip normal LLM turn.
3. Otherwise: load the member doc + conversation history from Firestore by `sessionId` (web) or phone number (SMS)
4. **Mode select:** `buildSystemPrompt(profile, {sms})` returns the onboarding interview prompt OR the connector prompt based on `isOnboarded(profile)` (true once `firstRecsMadeAt` is set). See "Two personality modes" below.
5. Append message → call OpenAI `gpt-4o-mini` with the chosen system prompt + history, `response_format: json_object`
6. Parse `{ reply, profileUpdate, searchQuery }` from response (`searchQuery` only ever populated in connector mode)
7. Save profile update + embed to Pinecone
8. **Recommendation step (mode-dependent):**
   - *Onboarding mode:* if `shouldRecommend(profile)` (name + memberType + ≥2 substantive fields, `firstRecsMadeAt` unset), run `makeFirstRecommendations` — search top 3 via `searchMembers({parseIntent:false})` excluding self, write a matchLog per candidate, GPT-write a natural blurb, append to reply, set `firstRecsMadeAt`. One-shot per member — this is the LAST onboarding turn; the next turn flips to connector mode.
   - *Connector mode:* if the model emitted a `searchQuery`, run `runConnectorSearch` — real `searchMembers({parseIntent:true})` over the directory, a matchLog per candidate (reason = the query + matchedOn breadcrumbs), 2nd GPT pass writes a warm intro blurb, appended to reply. Graceful "couldn't find a match yet" fallback when empty. No searchQuery = ordinary connector chat.
9. Save final reply + history
10. **Enqueue post-save pipeline:** `enqueuePostSave(memberId, profileUpdate, channel)` fires the `post-save-pipeline` Trigger.dev task (subscriptions, Google Maps → lat/lng, cross-reference verification, enrichment). This used to be fire-and-forget promises inside the function — Netlify killed them mid-flight once the response returned, so network-bound steps (Gemini/Jina/Places) rarely completed. Now they run reliably in Trigger.dev. Return to client.

**Two personality modes (`lib/systemPrompt.js`):**
- **Onboarding mode** (`ONBOARDING_PROMPT`) — warm neighbor doing a guided interview; aggressive structured data capture. Used until first recs fire.
- **Connector mode** (`CONNECTOR_PROMPT`) — "plugged-in local friend who knows everyone." Helps the member discover/connect via conversational search. **Never invents names** — when a connection would help it emits a `searchQuery` and the server fetches/introduces REAL matches in a 2nd pass. Still captures profile updates so the profile keeps enriching for life.
- Both share `SCHEMA_RULES` (flat schema + canonical fields + capture rules). `buildSystemPrompt(profile, {sms})` picks the mode and appends an SMS-brevity directive when `sms:true`. `SYSTEM_PROMPT` is kept as a back-compat alias for `ONBOARDING_PROMPT`.

**The self-improving loop (core thesis):**
Onboarding → rich profile → first recommendations (3 matchLogs) → 48h `followup-intros` cron sends "how'd it go?" → member replies → `extractOutcome` turns NL into structured signal + implicit profile updates → re-embed → next recommendations are smarter. Every completed matchLog is a labeled training example for a future re-ranker.

**Event harvest (Trigger.dev cron — daily 8am):**
1. Query all members with active subscriptions
2. For each subscription, scrape the channel URL via Jina Reader
3. Send content to GPT to detect events and reword in community-first voice
4. Save event suggestions to `eventSuggestions` collection with status "pending"
5. Admin reviews/approves (rejection captures structured `rejectionReason` + optional `rejectionNote` for future prompt analysis)

**Follow-up cron (hourly):** scan `matchLogs` for `status:"pending" && introducedAt < now-48h`. SMS members get a Telnyx follow-up; web members get a system-initiated assistant message appended to their history (appears on next chat load). Flips status to `followed_up`.

**Oakland harvest (weekly, Sun 9am):** iterate 9 seed types (restaurant, cafe, bar, bakery, store, art_gallery, beauty_salon, book_store, clothing_store) via Google Places Nearby Search around `37.8044,-122.2712` r=8km. Idempotent (skips existing `place_id`). For each new place: Place Details → GPT-enrich → store as member `gp_<place_id>` with `source:"google_places_harvest"`, `status:"unclaimed"` → embed with Pinecone metadata `unclaimed:true`. Requires `GOOGLE_PLACES_API_KEY`.

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
| `netlify/functions/lib/recommend.js` | `makeFirstRecommendations` (onboarding one-shot: COMPLEMENTARY match → semantic fallback → top 3 → matchLog per candidate → complementarity-aware blurb) + `findComplementaryMatches` (needs↔offers bidirectional match) + `findCollaboratorsForObjective` (free-text objective → who offers what it needs; powers the convener tool) + `runConnectorSearch` (connector-mode conversational search: NL query → real matches → matchLog + 2nd-pass intro blurb) |
| `netlify/functions/convener-search.js` | Admin: POST `{objective}` (free-text event/goal → complementary collaborators) or `{memberId}` (complementary matches for a member). Backs the admin.html Convener panel; pairs with `/match-log` to log intros. |
| `netlify/functions/backfill-locations.js` | Admin: parse googleMapsUrl → lat/lng for members missing coords |
| `netlify/functions/backfill-structured.js` | Admin: parse `priceRange` → `priceMin`/`priceMax`, normalize `pricePerProduct`, re-embed (Pinecone metadata refresh). `?reembedAll=1` to force re-embed every member |
| `netlify/functions/lib/priceParse.js` | `parsePriceRange("$10–$50") → {priceMin:10, priceMax:50}` + `normalizePricePerProduct()` |
| `tests/search.test.js` | 38 unit tests for parser + filter logic. Run `npm test` |
| `tests/e2e-search.js` | Real-stack proof of structured search (`buzz cut under $15 Chinatown`). Run `npm run test:e2e:search` |
| `tests/e2e-onboarding.js` | Drives the real chat handler; asserts GPT captures all new structured fields. Run `npm run test:e2e:onboarding` |
| `tests/e2e-complementary.js` | Real-stack proof of complementary matching: seeds a cafe (needs muralist) + muralist (offers murals) + decoy, asserts they surface each other via the offers/needs namespaces. Run `npm run test:e2e:complementary` |
| `tests/e2e-backfill.js` | Exercises `/backfill-structured` against real Firestore + Pinecone. Run `npm run test:e2e:backfill` |
| `netlify/functions/patch-member.js` | Admin: POST `{id, fields}` to set arbitrary profile fields on any member |
| `netlify/functions/match-log.js` | Admin: GET/POST `matchLogs` — record intros/recommendations made to a member |
| `netlify/functions/claim-profile.js` | Admin: POST `{unclaimedId, claimedBy?, fields?}` — flip a harvested profile to `claimed` |
| `netlify/functions/verify.js` | Admin: GET `?memberId=` lists available methods + current state; POST `{memberId, method, value}` runs ownership verification (Places API / Firecrawl / IG match / Gemini fallback) and writes `profile.ownershipVerification` on success |
| `netlify/functions/lib/verify.js` | Verification engine — ported from marketplace `feat/vendor-verification` branch; single source of truth for both apps |
| `netlify/functions/lib/verifyCrossRef.js` | Onboarding-time cross-reference verification: when a verifiable member type (vendor/artist/organizer/influencer) has ≥2 contact channels (website / GMaps / IG / phone), fires Gemini grounded check asking if all channels describe the same business; writes `profile.ownershipVerification` with confidence 0–1. Invoked from the `post-save-pipeline` Trigger task. |
| `netlify/functions/lib/triggerPostSave.js` | `enqueuePostSave(memberId, profileUpdate, channel)` — fires the `post-save-pipeline` Trigger.dev task from chat/sms. Swallows errors (e.g. missing `TRIGGER_SECRET_KEY` in local dev) so chat never fails on it. |
| `netlify/functions/lib/matchLog.js` | Firestore CRUD for `matchLogs` collection |
| `netlify/functions/lib/extractOutcome.js` | GPT outcome extractor — turns NL feedback into structured signal |
| `netlify/functions/lib/parseLocation.js` | Extracts lat/lng from Google Maps URLs (all formats + short links) |
| `netlify/functions/lib/taxonomy.js` | Canonical category/subcategory taxonomy + `TAXONOMY_PROMPT` for system prompt |
| `netlify/functions/lib/systemPrompt.js` | Dual-mode prompts: `ONBOARDING_PROMPT` (interview) + `CONNECTOR_PROMPT` (post-onboarding) sharing `SCHEMA_RULES`; `isOnboarded()` + `buildSystemPrompt(profile,{sms})` mode selector |
| `netlify/functions/lib/db.js` | Firestore lazy init + member/subscription CRUD |
| `netlify/functions/lib/vectorSearch.js` | OpenAI embedding + Pinecone upsert/query. Default namespace = full-profile vector (powers `/search` + connector). Also upserts an `offers` vector and a `needs` vector into separate namespaces; `queryComplementary` searches one against the other for complementary matching. `buildOffersText`/`buildNeedsText` synthesize the text (with fallbacks for legacy profiles) |
| `netlify/functions/lib/profileTool.js` | JSON parse helper with fallback |
| `netlify/functions/lib/enrich.js` | Jina Reader scraping, Google Places API, GPT profile extraction |
| `netlify/functions/lib/subscriptions.js` | Builds subscription records from captured profile fields |
| `netlify/functions/lib/events.js` | Event suggestion CRUD for Firestore |
| `netlify/functions/lib/syncToProlocaliq.js` | ProLocalIQ account sync |
| `trigger.config.ts` | Trigger.dev project config |
| `trigger/harvest-events.ts` | Daily cron job — scrape subscribed channels, detect + reword events |
| `trigger/followup-intros.ts` | Hourly cron — send 48h follow-up on pending matchLogs, route reply through `extractOutcome` |
| `trigger/harvest-oakland.ts` | Weekly cron — harvest Oakland businesses from Google Places, GPT-enrich, store as `status:"unclaimed"` |
| `trigger/post-save-pipeline.ts` | Event task (triggered per chat/sms turn) — reloads the member, then runs subscriptions, location parse, cross-ref verify, enrichment. Imports the netlify `lib/*` functions directly. Replaces the old fire-and-forget blocks that Netlify killed. (ProLocalIQ sync was removed — deprecated.) |

**Firestore collections:**

`members/{sessionId|phone}` — main member documents
```
profile (flat object — no nested objects allowed)
  memberType: "vendor" | "shopper" | "artist" | "organizer" | "influencer"
  interests, goals, painPoints, dislikes (arrays)
  needs (array — what they want FROM the community), offers (array — what they bring TO it); power complementary matching via the Pinecone `needs`/`offers` namespaces
  eventPostingPlatforms (array — e.g. ["instagram", "eventbrite", "website"])
  city, neighborhood, vibe, notes, personalNote, approvedBlurb, ...
  priceRange (string e.g. "$10–$50"), priceMin (number), priceMax (number)
  pricePerProduct ([{name, price}] — unlocks accurate per-item search like "buzz cut under $15")
  amenities (array, lowercase: "outdoor seating", "fireplace", "wifi", "dog friendly", "tv", "pool table", ...)
  atmosphere (array, lowercase: "quiet", "lively", "intimate", "dive bar", "date night", ...)
  acceptsEBT, acceptsCash, acceptsCrypto, wheelchairAccessible, freeParking (booleans)
  openLate, open24Hours, openWeekends (booleans)
  veganOptions, vegetarianOptions, glutenFree, halalCertified, kosher, byob, fullBar (booleans)
  sportsBar (bool), watchParties (bool), favoriteTeams (array, e.g. ["SF 49ers"])
  enrichedAt (ISO string — set after first enrichment)
  prolocaliqSynced, prolocaliqAccountId
  firstRecsMadeAt (ISO string — set after first recommendation round; gates one-shot)
  ownershipVerification (object — { verified, method, evidence, verifiedAt, verifiedValue } when /verify succeeds)
history: [{ role, content }]
status (top-level: "unclaimed" | "claimed" — only set for harvested profiles)
claimedAt, claimedBy
lastActiveAt, source ("web" | "sms" | "google_places_harvest"), phone (SMS only)
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
- **Vector metadata** now stores `memberType`, `onboardingComplete`, `city`, `neighborhood`, `category`, `subcategory`, `priceMin`/`priceMax`, all boolean amenity/access flags, `amenities[]`, `atmosphere[]`, `favoriteTeams[]`, plus flattened `productNames[]`/`productPriceMin`/`productPriceMax`. Hard filters run at the Pinecone metadata level — semantic ranking only sees candidates that already satisfy structured constraints. Full profile text still goes into the embedding. **Complementary matching** uses two extra Pinecone namespaces — `offers` and `needs` — each holding a per-member vector; `queryComplementary` embeds a member's needs and searches the `offers` namespace (and vice versa) so we surface members who *complement* rather than merely *resemble* each other.
- **Admin auth:** Bearer token (`ADMIN_TOKEN`) checked on `/admin`, `/matches`, `/enrich`, `/subscriptions`, `/event-suggestions`, `/match-log`, `/patch-member`, `/claim-profile`, `/convener-search`.
- **Marketplace endpoints are public** — `marketplace-members`, `marketplace-member`, `marketplace-events` require no auth. `phone` field stripped before returning.
- **Location capture:** vendors/organizers asked for Google Maps link → saved as `googleMapsUrl` → `parseLocation.js` extracts `latitude`/`longitude` in background post-save. Supports all URL formats + `maps.app.goo.gl` short links. Run `backfill-locations` (admin) to parse existing records missing coords.

## Environment Variables (Netlify)
`OPENAI_API_KEY`, `FIREBASE_PROJECT_ID` (`whatlocal-ab06e`), `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` (escaped `\\n`), `ADMIN_TOKEN`, `TELNYX_API_KEY`, `TELNYX_FROM_NUMBER`, `PINECONE_API_KEY`, `PINECONE_INDEX_NAME` (default: `community-members`), `TRIGGER_SECRET_KEY` (Trigger.dev API key — lets chat/sms enqueue the `post-save-pipeline` task; without it `enqueuePostSave` logs and no-ops, so the post-save background steps silently don't run)

**Profile enrichment:**
- `GOOGLE_PLACES_API_KEY` — Google Places API key for business lookups (optional; enrichment works without it using website-only scraping via Jina Reader)

**Ownership verification (`/verify`):**
- `GOOGLE_PLACES_API_KEY` — reused; phone cross-check via Places Text Search
- `FIRECRAWL_API_KEY` — website email scraping
- `GEMINI_API_KEY` — Gemini 2.0 Flash fallback when structured methods fail

**ProLocalIQ sync (DEPRECATED — removed from the post-save pipeline; lib kept unused):**
- `PROLOCALIQ_URL` — base URL of the prolocaliq Express server (e.g. `https://prolocaliq.com`)
- `CC_SYNC_TOKEN` — shared secret; must also be set on prolocaliq as `CC_SYNC_TOKEN`

**Trigger.dev (v4, project `xeno` / `proj_xlqnddtyofcgtvjudspi` under `xen-209f` org):**
- Deploy: `npx trigger.dev@latest deploy` (must match `@trigger.dev/sdk` v4.x pinned in package.json)
- Env vars set in Trigger.dev dashboard mirror Netlify: `OPENAI_API_KEY`, `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `PINECONE_API_KEY`, `PINECONE_INDEX_NAME`, `TELNYX_API_KEY`, `TELNYX_FROM_NUMBER` (for follow-up SMS), `GOOGLE_PLACES_API_KEY` (Oakland harvest + enrichment), `GEMINI_API_KEY` (cross-ref verify). The `post-save-pipeline` task needs firebase + OpenAI + Gemini + Places. Note: `FIRECRAWL_API_KEY`, `PROLOCALIQ_URL`, and `CC_SYNC_TOKEN` are NOT needed by the task (Firecrawl is only for the `/verify` endpoint; ProLocalIQ is deprecated).
- `TRIGGER_SECRET_KEY` must be set in **Netlify** (not Trigger.dev) so chat/sms can enqueue tasks
- `post-save-pipeline.ts` imports the netlify `lib/*.js` modules directly — they're lazy-init (firebase `getApps()` guard, lazy OpenAI client), so they bundle and run cleanly inside Trigger
- `trigger.config.ts` requires `runtime: "node-22"` and `maxDuration: 600`

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
- **Self-improving loop is live:** matchLog + extractOutcome + followup-intros cron close the feedback loop. Every onboarded member who passes `shouldRecommend` gets 3 first-round intros, each one a labeled training example once outcome feedback comes in. Verified end-to-end locally — implicit profile updates from a single NL reply got merged back correctly.
- **Unified search (`/search`)** is the single function backing both the public search bar and the chat agent's recommendation pipeline. GPT intent parser splits NL queries into `{semantic, filters, excludes, intent}`; pass `parseIntent:false` for recommendation queries (avoids over-aggressive hard filters on profile-text queries).
- **Proactive Oakland harvest:** weekly Google Places scrape builds `status:"unclaimed"` profiles for businesses that haven't signed up. Solves cold start — new members arrive to an already-populated network. Real claim verification (email/phone) still TODO; `claim-profile` is a stub for manual claims.
- **Trigger.dev v4 migration done** (was v3); import is `@trigger.dev/sdk` (not `/v3`), runtime `node-22`, project ref `proj_xlqnddtyofcgtvjudspi`. Pin the SDK exactly to whatever v4.x the CLI ships (caret ranges fail "Invalid Version").
- **Ownership verification engine ported from marketplace** — `lib/verify.js` is the single source of truth. Both apps call `/verify` here. Methods: phone (Google Places API), website_email (Firecrawl scrape + regex), instagram (handle match), gemini (Gemini 2.0 Flash with grounded search) as catch-all. Structured methods escalate to Gemini automatically on failure. Saves `profile.ownershipVerification` on success.
- **Structured search is live** — manifesto's "better than Google Maps" promise. Onboarding captures `pricePerProduct: [{name, price}]`, `amenities[]`, `atmosphere[]`, and booleans (acceptsEBT, openLate, wheelchairAccessible, sportsBar, favoriteTeams, veganOptions, etc.). `priceRange` strings auto-parse to `priceMin`/`priceMax` numerics in chat/sms post-save. Pinecone metadata now carries every filterable field — hard filters run server-side (`$lte` / `$in` / `$nin`) instead of in-memory on top-K. Each search result returns `matchedOn[]` breadcrumbs (e.g. `["buzz cut $12 ≤ $15", "tv ✓"]`). Per-product price gate: when a query carries `product` + `priceMax`, the business must offer a semantically-matching item at-or-under the cap. 81 assertions pass: 38 unit (`npm test`) + 43 e2e (`npm run test:e2e`).
- **Convener collaborator-search tool is live** — completes the convener vision (the "manually search who's a good fit for a specific event/objective" ask). Admin `/convener-search` endpoint + a Convener panel in `admin.html`: type a free-text objective ("event series about places of the world") → ranked complementary collaborators (via `findCollaboratorsForObjective`, treating the objective as a needs-query against the `offers` namespace), or pass a `memberId` for per-member complementary matches. Set an "anchor member" and one-click **Log intro** writes a matchLog (`reason: "convener: <objective>"`) → every manual convener intro becomes a labeled training example, same as the automatic ones. Verified by `tests/e2e-complementary.js` (runs where real creds exist).
- **Complementary needs↔offers matching is live (the convener engine)** — the strategic core from the recommendations-strategy conversation: recs are no longer just *similar* members but *complementary* ones. Onboarding + connector prompts capture canonical `needs[]` (what they want from the community) and `offers[]` (what they bring). `vectorSearch.js` upserts a per-member `offers` vector and `needs` vector into separate Pinecone namespaces; `queryComplementary` embeds a member's needs → searches the `offers` namespace (and offers → `needs`), bidirectionally, so we pair "wants in-store events" with "offers live mural painting." `makeFirstRecommendations` uses complementary matching first and falls back to semantic similarity for a sparse early network. Each matchLog records the `direction` of fit, and the blurb is framed around what the two could do together (collab/event). Wedge = fun creative local collaborations among vendors/artists/organizers/influencers. Legacy profiles get complementary vectors via fallback synthesis, populated on the next re-embed. Next step (separate task): an admin "find collaborators for a specific event/objective" tool that reuses `queryComplementary` + `match-log`.
- **Post-save background work moved to Trigger.dev** — subscriptions, location parse, cross-ref verification, enrichment, and prolocaliq sync used to run as fire-and-forget promises inside chat.js/sms.js. Netlify terminates the function as soon as the response is sent, so any network-bound step (Gemini, Jina, Google Places, OpenAI) was routinely killed before it finished. They now run in `trigger/post-save-pipeline.ts`, enqueued via `enqueuePostSave` (`lib/triggerPostSave.js`) once per turn. Requires `TRIGGER_SECRET_KEY` in Netlify. Fixed alongside this: the `shouldCrossRef` logic bug — the old gate was tangled around the rarely-set `businessName` field and special-cased only `vendor`, so artists/organizers/influencers with 2+ channels were ALWAYS skipped. Now gated on `VERIFIABLE_TYPES` (vendor/artist/organizer/influencer) + name + ≥2 channels.
- **Onboarding vs connector personality split is live** — the monolithic `SYSTEM_PROMPT` is now two prompts in `lib/systemPrompt.js`: `ONBOARDING_PROMPT` (warm guided interview) and `CONNECTOR_PROMPT` (post-onboarding "friend who knows everyone"). `buildSystemPrompt(profile,{sms})` selects per-turn via `isOnboarded(profile)` (gated on `firstRecsMadeAt`). Connector mode is forbidden from inventing members — it emits a `searchQuery`, the server runs a real directory search (`runConnectorSearch`), logs matchLogs, and a 2nd GPT pass writes the intro. Conversational recommendation engine is now live, and every connector intro is another labeled matchLog feeding the self-improving loop. chat.js + sms.js both load the member up front to pick the mode.

## Production TODO

### Deploy status (2026-06-05)
- ✅ Personality split, Trigger post-save pipeline, complementary matching, ProLocalIQ removal — all merged to `main` and pushed (Netlify auto-deploys).
- ✅ Trigger.dev: all 4 tasks deployed (version `20260605.5`); `post-save-pipeline` is live.
- ✅ Env: `TRIGGER_SECRET_KEY` set in Netlify; `GEMINI_API_KEY` set in Trigger.dev.
- ⬜ **Run once after the current Netlify deploy goes green:** `/backfill-structured?reembedAll=1` — refreshes Pinecone metadata with the expanded schema AND seeds the new `offers` / `needs` namespaces (via fallback synthesis in `buildOffersText`/`buildNeedsText`) so complementary matching covers pre-existing members. Idempotent; later runs can omit `?reembedAll=1`.
- ⬜ Smoke test: one web chat turn revealing a business → confirm a green `post-save-pipeline` run in the Trigger dashboard + `ownershipVerification` written to the member doc.

### Observability (PR #1 — `feat/observability-stack`)
- [ ] Set `SENTRY_DSN` in Netlify env vars (Site → Environment variables)
- [ ] Set `POSTHOG_API_KEY` (+ optional `POSTHOG_HOST`) in Netlify env vars
- [ ] Set the same two vars in Trigger.dev dashboard (project `xeno`) so the 3 crons emit too
- [ ] After deploy: complete one web onboarding + one SMS onboarding; confirm `profile_completed` + `first_recs_sent` appear in PostHog with correct `channel`
- [ ] After deploy: trigger one cron manually from Trigger.dev dashboard; confirm `event_harvest_run` / `oakland_harvest_run` / `followup_run` events land in PostHog
- [ ] In PostHog: build the funnel `profile_completed → first_recs_sent → outcome_received`, broken down by `channel` and `memberType` — that's the core self-improving-loop dashboard

### Marketplace observability (separate repo: `/Users/xen/Desktop/dev/community-marketplace`)
- [ ] Add PostHog **browser** SDK to the Next.js app → visitor analytics, geo, referrer, page views, session replay
- [ ] Use the same PostHog project as this app + stable `distinctId = memberId` so visitor → onboarding → outcome stitches into one funnel
- [ ] Optionally add Sentry browser SDK for client-side error tracking

### Uptime / synthetic checks
- [ ] Dashboard-only config (no code) — UptimeRobot or Checkly on:
  - `/.netlify/functions/chat` (POST with minimal payload)
  - `/.netlify/functions/search?q=test`
  - `/.netlify/functions/marketplace-members`
- [ ] Wire alerts to Slack/email

### Log aggregation (defer until pain)
- [ ] Skip unless Netlify function logs become painful to grep. Then: Axiom log drain (cheapest, generous free tier) or Better Stack.

## Changelog
See [CHANGELOG.md](./CHANGELOG.md) for history.
