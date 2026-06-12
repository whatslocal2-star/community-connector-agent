# Community Connector Agent

## What This Is
AI-driven community onboarding agent. Profiles local members (vendors, shoppers, artists, organizers, influencers) via web chat or SMS, stores profiles in Firestore, enables vector similarity + complementary matching via Pinecone, and harvests events from subscribed channels. Hosted on Netlify with Trigger.dev for background jobs.

**Signup + data layer** for the Community Marketplace (`/Users/xen/Desktop/dev/community-marketplace`) — a public Next.js app for browsing profiles and events.

## Architecture

**Per-turn request flow:**
1. Message arrives → web `POST /functions/chat` or Telnyx webhook `/functions/sms`
2. **Outcome short-circuit:** if member has a `followed_up` matchLog, route through `extractOutcome` → merge profile updates → re-embed → ack. Skip normal LLM turn.
3. Load member doc + history from Firestore (by `sessionId` or phone)
4. `buildSystemPrompt(profile, {sms})` picks **onboarding** or **connector** mode based on `isOnboarded()` (true once `firstRecsMadeAt` set)
5. Call `gpt-4o-mini` → parse `{ reply, profileUpdate, searchQuery }`
6. Save profile update + embed to Pinecone
7. **Recs:** onboarding mode → `makeFirstRecommendations` once `shouldRecommend` (one-shot, sets `firstRecsMadeAt`); connector mode → `runConnectorSearch` when `searchQuery` present
8. Save reply + history → enqueue `post-save-pipeline` Trigger.dev task → return

**Two modes (`lib/systemPrompt.js`):**
- **Onboarding** — warm guided interview, aggressive data capture. Until first recs fire.
- **Connector** — "friend who knows everyone." Emits `searchQuery`; server fetches real matches + writes intro blurb. Never invents names.

**Self-improving loop:** first recs → 48h followup cron → member replies → `extractOutcome` → implicit profile updates merged → re-embed → smarter next recs. Every matchLog = labeled training example.

**Convener (admin cockpit in `admin.html`):** review-and-approve tool with 3 collab types — **pairwise intro**, **group collab**, **event-first** (`lib/convener.js`). Generates proposals (complementary fit, semantic fallback when needs/offers sparse) with an admin summary + per-party message. Approving a `collabs` draft (`lib/collabs.js`) delivers it **in-app**: it's attached to each member's `pendingCollabs`, surfaced by the SAME connector persona as numbered options, and the member's reply (`collabResponses`) is recorded — no second bot. Interested parties → a multi-party **chat room** (`lib/collabRooms.js` + `room.js`, rendered marketplace-side). A proceed-majority vote distills a reusable **matchFormat** (`lib/matchFormats.js`); members build a per-format affinity. Liveness (`lib/collabActivity.js`): persistent decliners who also go quiet are pruned from the pool. The pairwise scan is parallelized (concurrent batches) to fit the function timeout. Supersedes the old `convener-search.js`.

**Convener review UX + rules:** each proposal carries a `basis` (`complementary` = real offers↔needs fit, shown as a green chip; `semantic` = profile similarity) and each party a `detail` snapshot — hover a party for its offers/needs, click for the full profile (`member-get.js`). **Member-type rules** (enforced in `loadMatchPool`/`findPairings`/`buildGroup`): shoppers are never collab parties; influencers are amplifiers — never in a pairwise intro, and in a group only as a 3rd+ party after a ≥2-person non-influencer core. **Env toggle:** `env: "real"|"sim"` runs the cockpit against the live network or the isolated **sim test environment** (`sim_members` collection + `sim-offers`/`sim-needs` namespaces, seeded via `seed-sim.js`) — fully separate, so the rich sim data proves complementary matching without touching real data.

**Crons (Trigger.dev):**
- Daily 8am: scrape subscribed channels → GPT event detection → `eventSuggestions` (pending)
- Hourly: followup-intros — 48h pending matchLogs → Telnyx SMS or system message
- Weekly Sun 9am: Oakland harvest — 9 place types via Google Places → unclaimed `gp_<place_id>` members
- Weekly Mon 7am: prune-collab-pool — reassess every member's `collabActivity.poolStatus` (active/dormant/removed)

## Key Files

| File | Purpose |
|------|---------|
| `index.html` / `admin.html` | Web chat UI / superadmin dashboard |
| `netlify/functions/chat.js` | Web chat handler |
| `netlify/functions/sms.js` | Telnyx webhook → SMS (fails CLOSED — needs `TELNYX_PUBLIC_KEY`) |
| `netlify/functions/search.js` | Public unified search — `?q=` or `POST {query, filters}` |
| `netlify/functions/lib/search.js` | Hybrid search: GPT intent parse → Pinecone semantic + hard filters |
| `netlify/functions/lib/recommend.js` | `makeFirstRecommendations`, `runConnectorSearch`, `findCollaboratorsForObjective` |
| `netlify/functions/lib/systemPrompt.js` | Dual-mode prompts + `buildSystemPrompt` mode selector |
| `netlify/functions/lib/vectorSearch.js` | OpenAI embed + Pinecone upsert/query; `offers`/`needs` namespaces for complementary matching |
| `netlify/functions/lib/verify.js` | Ownership verification engine (phone/google_maps/website_email/instagram/gemini) |
| `netlify/functions/lib/rateLimit.js` | Firestore fixed-window rate limiter (`enforceRateLimit` / `checkRateLimit`) |
| `netlify/functions/lib/matchLog.js` | matchLogs CRUD + `loadSuccessfulMatches` for Level 1 in-context learning |
| `netlify/functions/lib/extractOutcome.js` | GPT NL → structured outcome signal |
| `netlify/functions/lib/observability.js` | Sentry + PostHog (`initObservability` / `trackEvent` / `captureError` / `flushObservability`) |
| `netlify/functions/lib/composio.js` | Composio `@composio/core` client + `runTool(slug, memberId, args)` |
| `netlify/functions/lib/supabase.js` | Service-role Supabase client → writes `products`/`vendor_settings` for marketplace |
| `netlify/functions/verify.js` | Admin: run ownership verification |
| `netlify/functions/convener.js` | Admin: POST `{mode, env: real\|sim}` (pairings\|group\|invent-event\|next-best\|formats\|from-format) — generate proposals (no writes) |
| `netlify/functions/convener-collabs.js` | Admin: GET queue; POST `{action: save\|approve\|dismiss\|recur\|open-room}` |
| `netlify/functions/room.js` | Marketplace-facing collab chat API (auth: `MARKETPLACE_API_KEY`, member-scoped) |
| `netlify/functions/member-get.js` | Admin: GET `?id=` → full profile (checks `members` then `sim_members`; click-a-party modal) |
| `netlify/functions/seed-sim.js` | Admin: POST `{action: seed\|clear\|status}` — the isolated sim test env |
| `netlify/functions/lib/simSeed.js` | 18 rich interlocking sim members (needs/offers designed to complement) |
| `netlify/functions/lib/convener.js` | Matching engine: `findPairings` (parallel), `buildGroup`, `inventEvent`, `nextBestForRole`, `writeMessages`; `env` → `resolveEnv` (real vs sim collection+namespace) |
| `netlify/functions/lib/collabs.js` | `collabs` CRUD + approve→pending delivery; `pendingOptionsFor`, `recordCollabResponse` |
| `netlify/functions/lib/collabRooms.js` | `collabRooms` + messages + proceed/skip majority vote |
| `netlify/functions/lib/collabActivity.js` | Liveness gating — `assessPool`, decline tracking, format affinity |
| `netlify/functions/lib/matchFormats.js` | `matchFormats` — distill/clone a winning collab shape |
| `netlify/functions/lib/marketplaceAuth.js` | `isMarketplaceAuthorized` (Bearer `MARKETPLACE_API_KEY`) |
| `netlify/functions/convener-search.js` | ⚠️ DEAD — superseded by `convener.js`/`convener-collabs.js`; safe to delete |
| `netlify/functions/match-log.js` | Admin: GET/POST matchLogs + convener outcome verdicts |
| `netlify/functions/claim-profile.js` | Admin: flip unclaimed → claimed (gated on `ownershipVerification.verified`) |
| `netlify/functions/patch-member.js` | Admin: POST `{id, fields}` — set arbitrary profile fields |
| `netlify/functions/sms-send.js` | Admin: outbound transactional SMS via Telnyx |
| `netlify/functions/composio-connect.js` | Admin: initiate Composio OAuth for Shopify/Square |
| `netlify/functions/composio-sync.js` | Admin: sync vendor catalog → Supabase `products` |
| `netlify/functions/composio-push-order.js` | Admin: push marketplace order back to vendor's store |
| `netlify/functions/backfill-structured.js` | Admin: parse priceRange, re-embed — paginated (`?offset=&limit=`) |
| `trigger/post-save-pipeline.ts` | Per-turn background task: subscriptions, location parse, cross-ref verify, enrichment |
| `trigger/harvest-events.ts` / `harvest-oakland.ts` / `followup-intros.ts` / `prune-collab-pool.ts` | Daily/weekly/hourly/weekly crons |
| `tests/search.test.js` / `tests/convener.test.js` | Unit tests (111 total) — `npm test` |
| `tests/e2e-*.js` | Real-stack e2e tests — `npm run test:e2e` |

## Firestore Schema

**`members/{sessionId|phone}`**
```
profile (FLAT — no nested objects)
  memberType: "vendor"|"shopper"|"artist"|"organizer"|"influencer"
  interests, goals, painPoints, dislikes, needs, offers (arrays)
  city, neighborhood, vibe, notes, personalNote, approvedBlurb
  priceRange (string), priceMin/priceMax (numbers)
  pricePerProduct: [{name, price}]
  amenities, atmosphere, favoriteTeams (arrays)
  acceptsEBT, acceptsCash, wheelchairAccessible, freeParking, openLate, open24Hours,
  openWeekends, veganOptions, vegetarianOptions, glutenFree, halalCertified, byob,
  fullBar, sportsBar, watchParties (booleans)
  enrichedAt, firstRecsMadeAt (ISO strings)
  ownershipVerification: { verified, method, evidence, verifiedAt, verifiedValue }
history: [{role, content}]
status: "unclaimed"|"claimed" (harvested profiles only)
source: "web"|"sms"|"google_places_harvest"
pendingCollabs: [collabId]  — approved convener options awaiting this member's reply
collabActivity: { lastProposedAt, lastRespondedAt, lastInterestedAt, declineStreak,
                  poolStatus: "active"|"dormant"|"removed", formatAffinity: {sig: count}, nudgedAt }
```

**`matchLogs/{id}`** — intros + outcome feedback
```
memberId, matchedMemberId, reason, channel, status: "pending"|"followed_up"|"completed"
outcome: { attended, sentiment, reasons_positive[], reasons_negative[], would_repeat, implicit_profile_updates, summary }
```

**`eventSuggestions/{id}`** — harvested events pending admin review
```
status: "pending"|"approved"|"rejected"
rejectionReason: "not_local"|"too_promotional"|"already_posted"|"wrong_vibe"|"low_quality"|"duplicate"|"other"
```

**`collabs/{id}`** — Convener proposals (review → approve)
```
type: "intro"|"group"|"event", status: "flagged"|"approved"|"dismissed", source: "auto"|"manual"
title, description, adminSummary, seedMemberId, roomId
basis: "complementary"|"semantic", fit: [direction labels]   // why surfaced
parties: [{ memberId, memberName, memberType, role, message, score, partyStatus: "proposed"|"in"|"out",
            invitedAt, response: { decision: "interested"|"declined"|"maybe", note, respondedAt },
            detail: { neighborhood, city, vibe, offers[], needs[], description } }]  // hover/why snapshot
rolesNeeded: [{role, type, filled}], matchLogIds: []
```

**`sim_members/{id}`** — isolated sim test env (mirrors `members` profile shape; `seed:true`, `source:"sim"`). Vectors in `sim-offers`/`sim-needs` namespaces. Real flows never read it. Seed/clear via `seed-sim.js`.

**`collabRooms/{id}`** — multi-party chat (marketplace vendor UI renders it)
```
collabId, title, type, status: "open"|"closed", outcome: "proceeding"|"skipped"|null
participants: [{memberId, memberName, memberType, role}], participantIds: [id]
proceedVotes: {memberId: "proceed"|"skip"}
  subcollection messages/{id}: { senderId, senderName, text, system, createdAt }
```

**`matchFormats/{signature}`** — distilled winning collab shapes (id = `type|sortedTypes`)
```
signature, type, typeLineup: [memberType], exampleTitle, wins, sourceCollabIds: [], lastWonAt
```

**Write strategy:** `set({ merge: true })` for top-level fields; `update({ "profile.fieldName": value })` for profile fields.

## Key Conventions

- **Model returns JSON** `{ reply, profileUpdate }`. Parse failure → treat whole response as `reply`.
- **Profile fields are strictly flat.** No nested objects inside `profile`.
- **Every turn captures all context** — asides, URLs, personality details. Merge, never duplicate.
- **Enrichment only fills gaps** — never overwrites user-provided data.
- **Complementary matching** uses two Pinecone namespaces (`offers` / `needs`); `queryComplementary` embeds one against the other.
- **Pinecone metadata** carries all filterable fields — hard filters run server-side before semantic ranking.
- **Admin auth:** Bearer `ADMIN_TOKEN` on all `/admin`, `/matches`, `/enrich`, `/subscriptions`, `/event-suggestions`, `/match-log`, `/patch-member`, `/claim-profile`, `/convener`, `/convener-collabs`.
- **Convener never auto-sends.** Compute modes are read-only; approving delivers in-app via `pendingCollabs`. The connector agent relays options + parses `collabResponses` like it does `searchQuery` — one persona, one thread.
- **Collab member-type rules:** shoppers are consumers (never a collab party); influencers are amplifiers (never in a pairwise; group-only and only as a 3rd+ party after a ≥2-person non-influencer core). Effective core = vendor/artist/organizer.
- **Sim env is isolated:** `env:"sim"` ⇒ `sim_members` collection + `sim-*` namespaces. Real flows hardcode the real collection/namespaces, so there's no cross-contamination by construction.
- **Room API auth:** `/room` uses `MARKETPLACE_API_KEY` (shared secret); the marketplace server asserts `member_id`, verified as a participant. Never trust a client-supplied memberId.
- **Marketplace endpoints are public** (`marketplace-members`, `marketplace-member`, `marketplace-events`). Strip `phone` before returning.
- **SMS identical to web** except 1–3 sentence brevity directive; history capped at 20 messages.

## Environment Variables

**Core (Netlify):**
`OPENAI_API_KEY`, `FIREBASE_PROJECT_ID` (`whatlocal-ab06e`), `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` (escaped `\\n`), `ADMIN_TOKEN`, `PINECONE_API_KEY`, `PINECONE_INDEX_NAME` (default: `community-members`)

**SMS:** `TELNYX_API_KEY`, `TELNYX_FROM_NUMBER`, `TELNYX_PUBLIC_KEY` (ed25519 — **🔴 NOT SET in prod; SMS is DOWN**)

**Background jobs:** `TRIGGER_SECRET_KEY` (Netlify → lets chat/sms enqueue tasks; without it post-save steps silently skip)

**Collab rooms (cross-repo):** `MARKETPLACE_API_KEY` (Netlify — gates `/room`; ✅ SET in prod 2026-06-12, value also in local `.env.local`). Marketplace side (`community-marketplace`, separate Netlify site) must set `CONNECTOR_URL` + `CONNECTOR_MARKETPLACE_KEY` (= same value) for `app/api/vendor/collabs`.

**Enrichment + verification:** `GOOGLE_PLACES_API_KEY`, `FIRECRAWL_API_KEY`, `GEMINI_API_KEY`

**Commerce:** `COMPOSIO_API_KEY` (new `@composio/core` platform — legacy `composio-core` key 401s), `COMPOSIO_SHOPIFY_AUTH_CONFIG_ID`, `COMPOSIO_SQUARE_AUTH_CONFIG_ID`, `MARKETPLACE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`

**Trigger.dev dashboard** (project `xeno` / `proj_xlqnddtyofcgtvjudspi`): mirrors Netlify minus `TRIGGER_SECRET_KEY` and `FIRECRAWL_API_KEY`. Missing: `SENTRY_DSN`, `POSTHOG_API_KEY`, `POSTHOG_HOST` (crons don't emit yet).

## Deploy

- **Netlify:** `netlify deploy --prod` (manual — NOT git-triggered)
- **Trigger.dev:** `npx trigger.dev@latest deploy` (v4, runtime `node-22`, `maxDuration: 600`)
- Use `phc_` ingest key for `POSTHOG_API_KEY` (not `phx_` personal key)

## Active TODOs

**Commerce go-live (blocked):**
- 🔴 Get fresh `COMPOSIO_API_KEY` from current dashboard (old key is legacy platform, 401s)
- ⬜ Create Shopify + Square auth configs in Composio → set `COMPOSIO_SHOPIFY/SQUARE_AUTH_CONFIG_ID`
- ⬜ Set `MARKETPLACE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` in Netlify
- ⬜ Run `npm run test:e2e:commerce` end-to-end, then push (5 commits ahead of origin)
- ⬜ Catalog freshness: extract `syncVendorCatalog()`, add daily cron, deactivate removed products

**Infrastructure:**
- 🔴 Set `TELNYX_PUBLIC_KEY` in Netlify prod → fix SMS
- ⬜ Set `SENTRY_DSN` / `POSTHOG_API_KEY` / `POSTHOG_HOST` in Trigger.dev dashboard
- ⬜ Configure Firestore TTL on `rateLimits.expiresAt` (console → TTL policies)
- ⬜ Rotate `ADMIN_TOKEN` (was exposed in plaintext in a session)
- ⬜ Build PostHog funnel: `profile_completed → first_recs_sent → outcome_received`

**Convener / collab rooms:**
- ✅ Convener cockpit + in-app options + rooms + liveness + format learning shipped to prod (Netlify + Trigger.dev); `offers`/`needs` namespaces backfilled.
- 🟡 **Local-only refinements committed on `main`, NOT yet pushed/deployed** (user is dogfooding first): tabbed cockpit + button-visibility fix, parallelized pairwise scan (~5.5s), `basis` fit chips, shopper exclusion, influencer group-only/3rd+ rule, isolated **sim env** (`seed-sim.js`/`simSeed.js`), party hover detail + click-to-full-profile (`member-get.js`). When dogfooding passes → `netlify deploy --prod` (+ optionally seed sim in prod).
- ⬜ Marketplace `feat/collab-rooms` branch (pushed, not merged/deployed) — merge + set `CONNECTOR_URL`/`CONNECTOR_MARKETPLACE_KEY` on the marketplace site; nav link in `app/vendor/layout.tsx` left uncommitted with other WIP.
- ⬜ First `collabRooms` `participantIds` array-contains query may prompt for a Firestore single-field index.
- ⬜ Delete dead `convener-search.js`.
- ⬜ Perf option: `findPairings` re-embeds each member's text — could fetch stored `offers`/`needs` vectors instead.

**Stale branches (do not merge):** `feat/commerce-layer`, `feat/observability-stack`, `hjxkitchen/claude/recommendations-scalability-F2gpt` — all superseded by main.

## Changelog
See [CHANGELOG.md](./CHANGELOG.md).
