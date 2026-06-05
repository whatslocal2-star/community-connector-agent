# Changelog

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
