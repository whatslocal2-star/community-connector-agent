# Session Overview — 2026-06-05

**Theme:** Built out the *convener intelligence layer* end-to-end and shipped it to production — from two stranded plans (onboarding/connector split, observability) through a brand-new complementary-matching engine, the convener tooling that feeds it, and the first live layer of the self-improving intelligence stack.

**Outcome:** 12 commits, a full production deploy (Netlify + Trigger.dev), all 415 existing members backfilled, and observability live on the web tier. Prod had silently drifted to **May 18** before this session; everything since is now live.

---

## Executive summary

| # | Shipped | Status |
|---|---------|--------|
| 1 | Onboarding vs connector **personality split** + conversational search | ✅ live |
| 2 | Post-save background work → **Trigger.dev task** (+ `shouldCrossRef` bug fix) | ✅ live |
| 3 | **Complementary needs↔offers matching** (the convener engine) | ✅ live + verified in prod |
| 4 | **Convener collaborator-search tool** (admin) | ✅ live + verified in prod |
| 5 | **Convener outcome-logging** + **Level 1 in-context learning** | ✅ live |
| 6 | **Observability** (Sentry + PostHog) grafted onto current handlers + crons | ✅ live on web; crons pending Trigger env vars |
| — | ProLocalIQ sync removal; paginated backfill; doc updates | ✅ |
| — | `processTurn` refactor | ⏸️ deliberately deferred (see Decisions) |

---

## What was built

### 1. Onboarding vs connector personality split
*(Resumed from interrupted session `c1e9f3e0`, May 30.)*

The monolithic `SYSTEM_PROMPT` became two prompts in `lib/systemPrompt.js`:
- **`ONBOARDING_PROMPT`** — warm guided interview (data capture).
- **`CONNECTOR_PROMPT`** — post-onboarding "friend who knows everyone." **Forbidden from inventing members** — it emits a `searchQuery`; the server runs a real directory search and a 2nd GPT pass writes the intro.
- `buildSystemPrompt(profile, {sms})` + `isOnboarded(profile)` (gated on `firstRecsMadeAt`) select the mode per-turn.
- New `runConnectorSearch` (two-pass conversational recommendation); `parseCompletion` now surfaces `searchQuery`.

**Files:** `lib/systemPrompt.js`, `lib/profileTool.js`, `lib/recommend.js`, `chat.js`, `sms.js`.

### 2. Post-save work → Trigger.dev (+ shouldCrossRef fix)
*(Resumed from session `949aa81e`, May 30.)*

Subscriptions, location parse, cross-ref verification, and enrichment were fire-and-forget promises inside the Netlify function — **killed mid-flight** when the function returned. Moved to `trigger/post-save-pipeline.ts`, enqueued via `enqueuePostSave` (`lib/triggerPostSave.js`) once per turn. The task imports the netlify `lib/*` directly (lazy-init, bundles clean).

**Bug fixed:** `shouldCrossRef` was tangled around the rarely-set `businessName` field and special-cased only `vendor`, so **artists/organizers/influencers with 2+ channels were always skipped**. Now gated on `VERIFIABLE_TYPES` + name + ≥2 channels. (Regression tests added.)

**Requires:** `TRIGGER_SECRET_KEY` in Netlify.

### 3. Complementary needs↔offers matching — the convener engine
*(The strategic core, from the `recommendations-strategy` conversation, June 4.)*

Recommendations were *similarity*-based (two coffee shops). Now they're *complementary* (coffee shop ↔ muralist):
- Onboarding + connector prompts capture canonical **`needs[]`** and **`offers[]`**.
- `vectorSearch.js` upserts a per-member **`offers`** vector and **`needs`** vector into separate Pinecone namespaces (default namespace untouched).
- `queryComplementary` embeds a member's needs → searches the `offers` namespace (and offers → `needs`), **bidirectionally**.
- `makeFirstRecommendations` uses complementary first, falls back to semantic for a sparse network. matchLogs record the `direction` of fit; blurbs are framed around what the two could *do together*.

**Why it matters:** it solves — *structurally* — the exact gap the re-ranker was meant to *learn*: "a housing-justice organizer and a community muralist are a great match even if their embeddings aren't close."

### 4. Convener collaborator-search tool
*(Completes the convener vision — the "manually search who's a good fit for an event" ask, Turn 13 of the June-4 conversation.)*

- `convener-search.js` (admin): `POST {objective}` → members whose offers match what the objective needs (`findCollaboratorsForObjective`); or `POST {memberId}` → per-member complementary matches.
- **admin.html Convener panel** — type an objective → ranked collaborator cards → one-click **Log intro** (writes a matchLog) so manual convener intros become training examples.

### 5. Convener outcome-logging + Level 1 in-context learning
- **Outcome-logging:** `match-log` accepts `{matchLogId, verdict:"worked"|"didnt"}` → marks the intro completed with a structured outcome (same shape as the GPT followup extractor). Admin panel lists recent intros with 👍/👎. Lets the human convener label outcomes firsthand → **fast-tracks the ~50 outcomes the re-ranker needs**, instead of waiting on the 48h SMS loop.
- **Level 1:** `loadSuccessfulMatches` feeds positive completed intros into the recommendation/blurb prompts as worked-examples. Degrades gracefully when there are no outcomes yet.

### 6. Observability (Sentry + PostHog)
Grafted the stranded `feat/observability-stack` branch onto the **current** handlers (the branch was 26 commits stale) via `lib/observability.js`:
- Events: `outcome_received`, `profile_completed`, `first_recs_sent` (web+sms), `followup_sent`/`followup_run`, `event_harvest_run`, `oakland_harvest_run`. Errors → `captureError` (Sentry). All callers `flushObservability()` before returning (serverless).
- Fixed a latent bug from the branch (`recs.matches` → `recs.logs`).
- Connector + marketplace **share one PostHog project**, so funnels stitch across both apps.

---

## The intelligence stack — where we landed

From `LEARNINGS.md` (the May-7 vision): LLM reasoning + a learned re-ranker layered on top of semantic similarity.

| Layer | Status after this session |
|-------|---------------------------|
| Semantic similarity | ✅ live (Pinecone default namespace) |
| **Complementary matching** | ✅ live — *structural* fix for the re-ranker's motivating problem (not in the original plan) |
| Level 1 — in-context learning (LLM reasoning) | ✅ live |
| Outcome capture / convener labeling | ✅ live (the data accelerator) |
| Level 2 — learned re-ranker | ⬜ data-gated (~50 completed outcomes) |
| Level 3 — embedding fine-tuning | ⬜ ~200 labeled pairs |
| Level 4 — DSPy prompt optimization | ⬜ not started |

**Net:** three layers live + the labeling pipeline that unlocks the re-ranker. The re-ranker is now purely *data-gated*, not code-gated.

---

## Deploy & infrastructure actions

- **Discovered prod was on May-18 code** — Netlify deploys are **manual CLI** (`netlify deploy --prod`), not git-triggered. Redeployed everything.
- **Trigger.dev:** deployed all 4 tasks (latest `20260605.6`), including the new `post-save-pipeline`. (Hit transient Docker Hub DNS failures; cleared on retry.)
- **Backfill:** made `backfill-structured` **paginated/resumable** (the unpaginated full run timed out — the historical pain point), then ran it — **all 415 members re-embedded** into the `offers`/`needs` namespaces across 17 chunks.
- **Env vars set in Netlify:** `TRIGGER_SECRET_KEY`, `SENTRY_DSN`, `POSTHOG_API_KEY` (`phc_`), `POSTHOG_HOST`. In Trigger.dev: `GEMINI_API_KEY`.
- **Fixed `.env.local`:** the mislabeled `phx_` personal key (shadowing the correct `phc_` ingest key) → renamed to `POSTHOG_PERSONAL_API_KEY`.

---

## Verification

- **Unit tests:** 55/55 pass (added regression tests for `shouldCrossRef` + the complementary text builders).
- **e2e:** added `tests/e2e-complementary.js` (real-stack proof of complementary matching). *Note:* e2e can't run in the agent's local env (placeholder creds) — runs where real creds exist.
- **Live prod checks:** convener search returned real complementary matches (City Art Cooperative, Precita Eyes Muralists, etc. for a community-art objective); deployed `chat` function boots clean with the new deps (204 preflight / 400 validation).

---

## Key decisions & rationale

- **Complementary matching over waiting for the re-ranker** — solve the "far embeddings, great match" gap structurally now, rather than waiting weeks for outcome data to train a model.
- **Convener labels outcomes directly** — the human convener knows outcomes firsthand; capturing them directly is the fastest path to the re-ranker's data threshold.
- **Deferred the `processTurn` refactor** — `chat.js`/`sms.js` are ~70% duplicated and the refactor was tempting before grafting observability, but: they're the crown-jewel paths, integration tests can't run in this env, and prod was freshly stabilized. The duplication is cheap; the refactor's risk/reward was poor under feature pressure. Grafted observability into both directly instead. The refactor stays on the backlog as its own change with a real test net.
- **Removed ProLocalIQ sync** — deprecated; was dead code logging warnings each turn. Lib kept unused in case it's revived.

---

## Open items / follow-ups

- ⬜ **Trigger.dev dashboard env vars** — add `SENTRY_DSN` / `POSTHOG_API_KEY` (`phc_`) / `POSTHOG_HOST` so the 3 crons emit (web already does). No redeploy needed after.
- ⬜ **Rotate `ADMIN_TOKEN`** — exposed in plaintext during the session; it's a Netlify secret (unreadable back). Set fresh + redeploy.
- ⬜ **PostHog funnel** — `profile_completed → first_recs_sent → outcome_received` by `channel`/`memberType`. The self-improving-loop dashboard + the counter for when ~50 outcomes unlock the re-ranker.
- ⬜ **Re-ranker (Level 2)** — once ~50 completed outcomes accrue: scikit-learn model + offline train job (Trigger cron) + scoring hook in `recommend.js`.
- ⬜ **`processTurn` refactor** — dedupe the two handlers, with a real integration-test net.
- ⬜ **Marketplace observability** — PostHog browser SDK in the Next.js app (same project, `distinctId = memberId`) to stitch visitor → onboarding → outcome.
- ⬜ **Git auto-deploy** — consider wiring Netlify git-triggered deploys so prod stops drifting (or always `netlify deploy --prod` after push).

---

## Commits (in order)

```
e0f58ac  chore: add geocoding backfill scripts + session log
3dd5764  feat:  split onboarding vs connector personality modes
9cbd165  fix:   move post-save background work to Trigger.dev + fix shouldCrossRef
6c3c3f5  feat:  complementary needs<->offers matching (convener engine)
0ae9b3a  chore: remove deprecated ProLocalIQ sync from post-save pipeline
45da573  docs:  refresh CLAUDE.md deploy status + add CHANGELOG
e0f3f59  feat:  convener collaborator-search tool + complementary e2e
bd6495f  feat:  convener outcome-logging + Level 1 in-context learning
b41b4e1  fix:   paginate backfill-structured to avoid function timeout
1a9d83b  docs:  map LEARNINGS.md intelligence stack to what's actually built
fa67a3d  feat:  graft observability (Sentry + PostHog) onto current handlers + crons
e33e36a  docs:  update CLAUDE.md deploy status (observability live, backfill done)
```
