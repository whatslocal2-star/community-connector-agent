# Phase A — Commerce functions (Composio + SMS)

These four Netlify functions complete the marketplace's catalog-sync, order
push-back, and delivery-SMS loop. The Next.js marketplace already calls them;
before this they 404'd.

| Function | Marketplace caller | Contract |
|---|---|---|
| `sms-send` | `app/api/uber/webhook` | `POST { to, message }` → `{ sent }` |
| `composio-connect` | `app/api/vendor/composio` (action `connect`) | `POST { memberId, platform }` → `{ url }` |
| `composio-sync` | `app/api/vendor/composio` (action `sync`) | `POST { memberId }` → `{ synced, platform }` |
| `composio-push-order` | `app/api/stripe-webhook` (`payment_intent.succeeded`) | `POST { memberId, order }` → `{ pushed, platform }` |

All require `Authorization: Bearer ADMIN_TOKEN`.

## What's wired
- **Shopify**: connect → sync (`SHOPIFY_LIST_ALL_PRODUCTS`) → push order (`SHOPIFY_CREATE_ORDER`). Full loop.
- **Square**: connect + sync (`SQUARE_LIST_CATALOG`) wired; push-back (`SQUARE_CREATE_ORDER`) wired but **unverified** — confirm arg schema in dashboard. Square images deferred (need a second lookup).
- **Toast**: not supported — Composio has no Toast toolkit. Needs Toast Partner Connect or a unified-POS aggregator (separate track).

## Required setup before it works live
1. **Composio dashboard** (dashboard.composio.dev):
   - Create an API key → `COMPOSIO_API_KEY`.
   - Create one **Auth Config** per platform → `COMPOSIO_SHOPIFY_AUTH_CONFIG_ID`, `COMPOSIO_SQUARE_AUTH_CONFIG_ID`.
   - Verify exact arg/return schemas under Auth Configs → Tools & Triggers for each slug in `lib/composio.js` (`TOOL_SLUGS`). The product/order mappers in `composio-sync.js` / `composio-push-order.js` assume the standard Shopify REST + Square catalog shapes.
2. **Supabase** (shared `xeno` project): set `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` in connector-agent's Netlify env. These functions write `products` and `vendor_settings`.
3. **`MARKETPLACE_URL`** — where Composio redirects the vendor post-auth.

## Connection model
Connections and tool calls are scoped by `userId = marketplace memberId`, so a
vendor's store is resolvable from their member id alone — no per-call handle is
stored. `vendor_settings.composio_connection_id` is set at connect time and
doubles as the "is connected" flag the marketplace UI + webhook gate read.
`composio-sync` confirms the live connection by listing the real catalog.

## Not yet done (Phase A follow-ups)
- Deactivate `products` rows that disappear from the source catalog (currently sync only upserts).
- Square product images.
- Verify against a real Composio account end-to-end (needs the credentials above — could not be tested at build time).
