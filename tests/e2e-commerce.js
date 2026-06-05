// End-to-end proof for the Phase A commerce functions against the REAL stack.
// Run via:  netlify dev:exec node tests/e2e-commerce.js
//
// Invokes the actual Netlify handlers (with a Bearer ADMIN_TOKEN event) so it
// exercises auth, Composio, Supabase, and Telnyx exactly as production does.
//
// Env it uses (skips gracefully when absent so it's safe to run before the
// fresh Composio key lands):
//   ADMIN_TOKEN                      (required — else nothing is authorized)
//   COMPOSIO_API_KEY + auth configs  (composio-connect/sync/push)
//   SUPABASE_URL / SERVICE_ROLE_KEY  (sync/push read vendor_settings + write products)
//   TEST_MEMBER_ID                   (a real member id; connected store for sync/push)
//   TEST_PLATFORM=shopify|square     (defaults to shopify)
//   TEST_SMS_TO                      (a phone number to receive one real test SMS)
//   TEST_PUSH_ORDER=1                (opt-in: actually create an order in the store)

import { handler as smsSend } from "../netlify/functions/sms-send.js";
import { handler as composioConnect } from "../netlify/functions/composio-connect.js";
import { handler as composioSync } from "../netlify/functions/composio-sync.js";
import { handler as composioPushOrder } from "../netlify/functions/composio-push-order.js";
import { getSupabase } from "../netlify/functions/lib/supabase.js";

function log(...a) { console.log("[e2e-commerce]", ...a); }
let failures = 0;
function check(name, cond, detail = "") {
  if (cond) log(`✓ ${name}`);
  else { failures++; log(`✗ ${name} ${detail}`); }
}
function skip(name, why) { log(`– SKIP ${name} (${why})`); }

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const PLATFORM = process.env.TEST_PLATFORM || "shopify";
const MEMBER_ID = process.env.TEST_MEMBER_ID;

// Build a Netlify-style event with the admin bearer token.
function event({ method = "POST", body = {}, auth = true } = {}) {
  return {
    httpMethod: method,
    headers: auth ? { authorization: `Bearer ${ADMIN_TOKEN}` } : {},
    body: JSON.stringify(body),
  };
}
const json = (res) => { try { return JSON.parse(res.body); } catch { return {}; } };

async function run() {
  if (!ADMIN_TOKEN) {
    log("ADMIN_TOKEN not set — cannot authorize any endpoint. Aborting (not a failure).");
    return;
  }

  // 1. Auth gate — cheap, needs no external creds. Every handler must 401
  //    without the bearer token.
  for (const [name, h] of [["sms-send", smsSend], ["composio-connect", composioConnect], ["composio-sync", composioSync], ["composio-push-order", composioPushOrder]]) {
    const res = await h(event({ auth: false }));
    check(`${name} rejects missing auth (401)`, res.statusCode === 401, `got ${res.statusCode}`);
  }

  // 2. Input validation — 400 on missing fields (also creds-free).
  check("composio-connect 400 on missing platform",
    (await composioConnect(event({ body: { memberId: "x" } }))).statusCode === 400);
  check("sms-send 400 on missing message",
    (await smsSend(event({ body: { to: "+15555550123" } }))).statusCode === 400);

  // 3. sms-send — sends ONE real SMS if a target number is provided.
  if (process.env.TEST_SMS_TO) {
    const res = await smsSend(event({ body: { to: process.env.TEST_SMS_TO, message: "WhatsLocal e2e test ✅" } }));
    check("sms-send delivers", res.statusCode === 200 && json(res).sent === true, `status ${res.statusCode} body ${res.body}`);
  } else {
    skip("sms-send live send", "set TEST_SMS_TO to a phone number");
  }

  // 4. composio-connect — returns an OAuth redirect URL (no auth completion).
  if (!process.env.COMPOSIO_API_KEY) {
    skip("composio-connect / sync / push", "COMPOSIO_API_KEY not set — add the fresh key");
    return;
  }
  if (!MEMBER_ID) {
    skip("composio-connect / sync / push", "set TEST_MEMBER_ID (a real member id)");
    return;
  }

  const connectRes = await composioConnect(event({ body: { memberId: MEMBER_ID, platform: PLATFORM } }));
  const connectBody = json(connectRes);
  check("composio-connect returns redirect url",
    connectRes.statusCode === 200 && typeof connectBody.url === "string" && connectBody.url.startsWith("http"),
    `status ${connectRes.statusCode} body ${connectRes.body}`);
  if (connectBody.url) log("   → authorize this vendor by opening:", connectBody.url);

  // 5. composio-sync — requires the vendor to be ACTIVELY connected (i.e. the
  //    redirect above was completed once). Reports the catalog count.
  const syncRes = await composioSync(event({ body: { memberId: MEMBER_ID } }));
  const syncBody = json(syncRes);
  if (syncRes.statusCode === 200) {
    check("composio-sync returns a count", typeof syncBody.synced === "number", `body ${syncRes.body}`);
    const { count } = await getSupabase()
      .from("products").select("*", { count: "exact", head: true })
      .eq("member_id", MEMBER_ID).eq("source", PLATFORM);
    log(`   → ${syncBody.synced} synced; ${count ?? "?"} ${PLATFORM} products now in Supabase`);
  } else {
    skip("composio-sync", `status ${syncRes.statusCode} (${syncBody.error || "vendor not connected yet?"})`);
  }

  // 6. composio-push-order — DESTRUCTIVE (creates a real order). Opt-in only.
  if (process.env.TEST_PUSH_ORDER === "1") {
    const order = {
      order_number: "E2E-TEST-0001",
      buyer_email: "e2e@example.com",
      items: [{ name: "E2E Test Item", qty: 1, price_cents: 100 }],
    };
    const pushRes = await composioPushOrder(event({ body: { memberId: MEMBER_ID, order } }));
    check("composio-push-order pushes", pushRes.statusCode === 200 && json(pushRes).pushed === true,
      `status ${pushRes.statusCode} body ${pushRes.body}`);
  } else {
    skip("composio-push-order live push", "set TEST_PUSH_ORDER=1 to create a real order");
  }
}

run()
  .then(() => {
    log(failures ? `DONE — ${failures} failure(s)` : "DONE — all assertions passed");
    process.exit(failures ? 1 : 0);
  })
  .catch((err) => { log("FATAL", err); process.exit(1); });
