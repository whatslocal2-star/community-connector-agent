# Changelog

## 2026-06-05
- Split the monolithic system prompt into onboarding vs connector personality modes; added two-pass conversational search in connector mode.
- Moved post-save background work (subscriptions, location parse, cross-ref verify, enrichment) from fire-and-forget to a Trigger.dev `post-save-pipeline` task; fixed `shouldCrossRef` gate (was always skipping artists/organizers/influencers).
- Added complementary needs↔offers matching (the convener engine): `needs[]`/`offers[]` capture + dedicated Pinecone namespaces + bidirectional `queryComplementary`; first-recs now prefer complementary matches.
- Removed deprecated ProLocalIQ sync from the pipeline.
- Deployed all 4 Trigger.dev tasks (v20260605.5); pushed to `main`.
