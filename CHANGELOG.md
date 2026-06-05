# Changelog

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
