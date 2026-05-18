// End-to-end proof of /backfill-structured.
// Seeds a legacy-shaped member (priceRange string, no priceMin/Max,
// pricePerProduct as raw strings), runs the backfill handler, asserts the
// numerics + normalized menu were written and the vector was re-upserted.
//
// Run via:  netlify dev:exec node tests/e2e-backfill.js

import { handler as backfillHandler } from "../netlify/functions/backfill-structured.js";
import { getDb, loadMember } from "../netlify/functions/lib/db.js";
import { deleteMemberVectors } from "../netlify/functions/lib/vectorSearch.js";
import { searchMembers } from "../netlify/functions/lib/search.js";

const ID = `test_e2e_backfill_${Date.now()}`;
const log = (...a) => console.log("[backfill-e2e]", ...a);

function assertOk(cond, msg, ctx) {
  if (!cond) {
    console.error("❌", msg, ctx !== undefined ? JSON.stringify(ctx) : "");
    process.exitCode = 1;
  } else {
    console.log("✅", msg);
  }
}

async function seedLegacy() {
  log("Seeding legacy-shaped member", ID);
  await getDb().collection("members").doc(ID).set({
    profile: {
      name: "Legacy Backfill Barber",
      memberType: "vendor",
      category: "barbershop",
      city: "san francisco",
      neighborhood: "chinatown",
      priceRange: "$15 to $40",          // string only — no numerics yet
      pricePerProduct: [                  // raw strings, not {name, price}
        "buzz cut $15",
        "fade — 30",
        "beard trim",
      ],
      amenities: ["tv"],
      businessDescription: "Legacy doc — pre structured-search.",
      onboardingComplete: true,
    },
    source: "e2e_backfill_test",
    lastActiveAt: new Date().toISOString(),
  });
}

async function cleanup() {
  log("Cleanup");
  try { await getDb().collection("members").doc(ID).delete(); } catch (e) { log("  warn:", e.message); }
  await deleteMemberVectors([ID]);
}

async function main() {
  await seedLegacy();

  // Sanity check the legacy doc looks the way we expect BEFORE the backfill.
  const before = await loadMember(ID);
  log("BEFORE:", JSON.stringify({
    priceRange: before.profile.priceRange,
    priceMin: before.profile.priceMin,
    priceMax: before.profile.priceMax,
    pricePerProduct: before.profile.pricePerProduct,
  }));
  assertOk(before.profile.priceMin == null, "legacy doc has no priceMin yet");
  assertOk(before.profile.priceMax == null, "legacy doc has no priceMax yet");
  assertOk(typeof before.profile.pricePerProduct[0] === "string",
    "legacy pricePerProduct is raw strings");

  // Hit the backfill endpoint.
  const event = {
    httpMethod: "GET",
    headers: { authorization: `Bearer ${process.env.ADMIN_TOKEN}` },
    queryStringParameters: {},
  };
  log("Calling /backfill-structured...");
  const res = await backfillHandler(event);
  assertOk(res.statusCode === 200, "backfill returned 200", res.statusCode);
  const body = JSON.parse(res.body);
  log(`  scanned=${body.scanned} updated=${body.updated}`);
  const ourEntry = body.results.find(r => r.id === ID);
  assertOk(ourEntry, "our member appears in backfill results", ourEntry);

  // Verify the post-backfill profile.
  const after = await loadMember(ID);
  log("AFTER:", JSON.stringify({
    priceRange: after.profile.priceRange,
    priceMin: after.profile.priceMin,
    priceMax: after.profile.priceMax,
    pricePerProduct: after.profile.pricePerProduct,
  }));
  assertOk(after.profile.priceMin === 15, "priceMin written as 15", after.profile.priceMin);
  assertOk(after.profile.priceMax === 40, "priceMax written as 40", after.profile.priceMax);
  assertOk(Array.isArray(after.profile.pricePerProduct), "pricePerProduct is array");
  const ppp = after.profile.pricePerProduct;
  const buzz = ppp.find(x => /buzz/i.test(x?.name || ""));
  const fade = ppp.find(x => /fade/i.test(x?.name || ""));
  const beard = ppp.find(x => /beard/i.test(x?.name || ""));
  assertOk(buzz && buzz.price === 15, "buzz cut normalized → $15", buzz);
  assertOk(fade && fade.price === 30, "fade normalized → $30", fade);
  assertOk(beard && beard.price === null, "beard trim (no price) → null", beard);

  // Pinecone metadata refresh — wait for indexing then query.
  log("Waiting 4s for Pinecone reindex...");
  await new Promise(r => setTimeout(r, 4000));

  const search = await searchMembers({
    query: "buzz cut chinatown",
    filters: { neighborhood: "chinatown", product: "buzz cut", priceMax: 20 },
    parseIntent: false,
    limit: 50,
  });
  const ids = search.results.map(r => r.id);
  log("search results:", ids);
  assertOk(ids.includes(ID), "post-backfill member is searchable with structured filters");
  const winner = search.results.find(r => r.id === ID);
  if (winner) {
    assertOk(
      winner.matchedOn.some(m => /buzz cut/i.test(m) && /15/.test(m)),
      "post-backfill matchedOn surfaces buzz cut $15",
      winner.matchedOn
    );
  }

  // Negative — same member should NOT match a $10 cap.
  const tight = await searchMembers({
    query: "buzz cut chinatown",
    filters: { neighborhood: "chinatown", product: "buzz cut", priceMax: 10 },
    parseIntent: false,
    limit: 50,
  });
  assertOk(!tight.results.map(r => r.id).includes(ID),
    "member excluded when priceMax=$10 (buzz cut is $15)");
}

main()
  .catch(e => { console.error("FATAL:", e); process.exitCode = 1; })
  .finally(async () => {
    await cleanup();
    console.log(process.exitCode === 1 ? "\n❌ BACKFILL E2E FAILED" : "\n✅ BACKFILL E2E PASSED");
  });
