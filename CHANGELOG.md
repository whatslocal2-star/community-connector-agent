# Changelog

## 2026-06-12 (Convener review UX, matching rules, sim env — local, pre-deploy)
Refinements after dogfooding the deployed cockpit. All committed on `main` locally; **not yet pushed/deployed** (user is confirming locally first).
- **Tabbed cockpit + button-visibility fix:** the panel is now tabs (Pairwise · Group · Create event · Review queue · Learned formats), each with its own trigger + results. Fixed `.refresh-btn` rendering white-on-white on the light panel (buttons were invisible).
- **"Why this match":** each proposal shows a `basis` chip — green **complementary fit** (real offers↔needs) vs grey **similar profile** (semantic). Carried through compose + persisted on the collab.
- **Party analysis:** hover any party for a snapshot (location, vibe, offers, needs); click for the full profile modal (`member-get.js` — works for real + sim members).
- **Matching rules:** shoppers excluded from the collab pool (consumers, not collaborators); influencers are amplifiers — never in a pairwise, group-only and only as a 3rd+ party after a ≥2-person non-influencer core.
- **Isolated sim test environment:** `sim_members` collection + `sim-offers`/`sim-needs` Pinecone namespaces, 18 rich interlocking members (`lib/simSeed.js`), seed/clear via `seed-sim.js`, Real/Sim toggle in the UI. Proves complementary matching (verified: muralist↔cafe, DJ↔wine bar, food-influencer↔restaurant) with zero leakage into real data. `env` threads through the whole engine (`resolveEnv` → collection + namespace).
- **Perf:** parallelized the pairwise scan (concurrent batches + concurrent compose) — was timing out (~30s) at the higher default, now ~5.5s.

## 2026-06-12 (Convener redesign → prod)
- **Convener cockpit:** rebuilt the admin Convener from a search+log tool into a tabbed review-and-approve cockpit with 3 collab types — pairwise intro, group collab, event-first. New `lib/convener.js` matching engine (complementary fit + semantic fallback), `lib/collabs.js` `collabs` model, `convener.js` / `convener-collabs.js` endpoints.
- **In-app delivery loop:** approving a collab attaches it to each member's `pendingCollabs`; the same connector persona relays numbered options and records `collabResponses` (no second bot). `lib/collabRooms.js` + `room.js` + marketplace `app/vendor/collabs` give interested parties a multi-party chat room with a proceed/skip majority vote.
- **Liveness + format learning:** `lib/collabActivity.js` prunes persistent decliners who go quiet (`prune-collab-pool` weekly cron); `lib/matchFormats.js` distills a winning collab shape on a proceed-majority and biases members toward formats they liked.
- **Shipped to prod:** Netlify + Trigger.dev (v20260612.1) deployed; backfilled all 415 members so `offers`/`needs` namespaces are populated (complementary matching live). Set `MARKETPLACE_API_KEY`. 111 unit tests green.
- **Fixes found in testing:** `buildNeedsText`/`buildOffersText` crashed on dirty (string-not-array) profile fields; parallelized the pairwise scan (was ~30s → ~5.5s) to fit the function timeout.

## 2026-06-05 (pre-launch trust + abuse hardening)
- **Rate limiting (was NONE):** new `lib/rateLimit.js` — Firestore fixed-window limiter, shared across serverless instances, fails OPEN on limiter error. Guards the public unauthenticated endpoints: `/chat` 30/min/IP, `/search` 60/min/IP, plus a per-member throttle on `/verify` (12/hr/member) so the claim form can't brute-force a phone/handle or run up Places/Gemini spend. Counter docs carry `expiresAt` for a Firestore TTL sweep (needs one-time console config).
- **Self-serve claim flow hardened:** `claim-profile.js` is no longer a stub — it now gates on `profile.ownershipVerification.verified` (refuses unverified claims; `force:true` = admin backfill override), returns 409 on re-claim, and records `claimMethod`. Backs the merged marketplace Clerk claim UI (`/api/claim` BFF → verify → claim-profile).
- **Verification engine:** fixed the method mismatch that 400'd the claim UI's second button — added the `google_maps` method to `lib/verify.js` (resolve pasted Maps URL/Place ID via Places API → match the profile by place_id → phone → name). Also normalized US phone country codes (`+1 510-…` now matches the bare 10-digit form). New `tests/verify.test.js` (10 cases); full suite 65/65 green.
- **Audit verification (items 3–5 from the post-5/17 review):** confirmed PII strip + Telnyx signature-verify code are live. 🔴 Found `TELNYX_PUBLIC_KEY` is NOT set in Netlify prod → inbound SMS is fully 401'd / down until set. Composio store-connect (item 4) is marketplace-side, gated behind the vendor portal, out of v1 scope — deferred. Observability (item 5): Netlify vars set (web+sms emit); Trigger.dev dashboard vars + PostHog funnel still pending. All flagged in CLAUDE.md Production TODO.

## 2026-06-05 (commerce — Phase A)
- Built the four commerce endpoints the marketplace already called but that never existed (every call was 404'ing): `sms-send` (outbound Telnyx — makes Uber Direct delivery texts work), `composio-connect` (Composio OAuth → `vendor_settings`), `composio-sync` (Shopify/Square catalog → Supabase `products`, idempotent on `member_id,external_id`), `composio-push-order` (order back into the vendor's store on payment).
- New shared libs: `lib/composio.js` (`@composio/core` client, `userId=memberId` scoping, `TOOL_SLUGS`, `runTool`) and `lib/supabase.js` (service-role client for the shared `xeno` commerce tables). Deps: `@composio/core`, `@supabase/supabase-js`.
- Square sync now pulls `ITEM,IMAGE` in one `ListCatalog` call and resolves `item.image_ids[0]` → image URL.
- `tests/e2e-commerce.js` (+ `npm run test:e2e:commerce`): invokes all four handlers against the real stack; auth-gate + input-validation assertions run creds-free (green), Composio/Supabase/SMS steps skip gracefully until the fresh key + `TEST_MEMBER_ID` are set.
- Decisions/gaps: chose the new `@composio/core` platform over the legacy `composio-core` mae uses (its key 401s here — fresh key needed). Shopify is the full loop; Square push-back wired-but-unverified; Toast unsupported (no Composio toolkit). Not-yet-done: verify Square `CREATE_ORDER` schema, deactivate `products` removed from source. See `PHASE-A-COMMERCE.md`.

## 2026-06-05 (cleanup)
- Removed `lib/syncToProlocaliq.js` and `link-identity.js` — LocalLoop integration dropped; Community Marketplace is the sole public-facing app linked to this connector.
- Scrubbed all ProLocalIQ/LocalLoop references from CLAUDE.md (file table, env vars, Firestore schema, decision log).

## 2026-06-05 (deploy + config)
- Deployed all accumulated work to prod (Netlify manual CLI + Trigger v20260605.6); prod had drifted to May 18.
- Ran the paginated backfill — all 415 members re-embedded into the offers/needs namespaces; live convener search verified in prod.
- Set Netlify env: TRIGGER_SECRET_KEY, SENTRY_DSN, POSTHOG_API_KEY (phc_), POSTHOG_HOST. Fixed .env.local mislabeled phx_ key (→ POSTHOG_PERSONAL_API_KEY). Made backfill-structured paginated/resumable to avoid the function timeout.

## 2026-06-05 (observability)
- Grafted the server-side observability stack (Sentry + PostHog) from the stranded feat/observability-stack branch onto current chat.js/sms.js + all 3 crons via lib/observability.js. Emits profile_completed / first_recs_sent / outcome_received (web+sms) + cron run events; no-ops without env vars. Chose to graft rather than merge the stale branch (26 commits behind) and skipped the processTurn refactor for now (too risky without runnable integration tests on the two core handlers). Fixed the branch's stale recCount (recs.matches -> recs.logs). Deps: @sentry/node, posthog-node.

## 2026-06-05 (docs)
- LEARNINGS.md: added an implementation-status mapping of the layered-intelligence vision to what's shipped; documented complementary matching as the structural fix for the re-ranker's motivating problem; corrected stale tech-stack notes (embedding model is text-embedding-3-small; offers/needs namespaces).

## 2026-06-05 (intelligence)
- Convener outcome-logging: `match-log` accepts `{matchLogId, verdict}` to mark an intro worked/didn't; admin Convener panel lists recent intros with 👍/👎 controls. Human convener labels outcomes firsthand → fast-tracks re-ranker training data.
- Level 1 in-context learning: `loadSuccessfulMatches` injects positive past intros into the first-recs + connector blurb prompts so recs learn from what worked.

## 2026-06-05 (later)
- Added the convener collaborator-search tool: `/convener-search` admin endpoint + Convener panel in admin.html (objective → complementary collaborators, one-click "Log intro" → matchLog). New `findCollaboratorsForObjective` in recommend.js.
- Added `tests/e2e-complementary.js` real-stack proof of complementary matching (+ `npm run test:e2e:complementary`).

## 2026-06-05
- Split the monolithic system prompt into onboarding vs connector personality modes; added two-pass conversational search in connector mode.
- Moved post-save background work (subscriptions, location parse, cross-ref verify, enrichment) from fire-and-forget to a Trigger.dev `post-save-pipeline` task; fixed `shouldCrossRef` gate (was always skipping artists/organizers/influencers).
- Added complementary needs↔offers matching (the convener engine): `needs[]`/`offers[]` capture + dedicated Pinecone namespaces + bidirectional `queryComplementary`; first-recs now prefer complementary matches.
- Removed deprecated ProLocalIQ sync from the pipeline.
- Deployed all 4 Trigger.dev tasks (v20260605.5); pushed to `main`.
