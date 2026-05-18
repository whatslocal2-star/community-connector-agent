// End-to-end proof that structured search works against the REAL stack.
// Run via:  netlify dev:exec node tests/e2e-search.js
//
// Creates a fake barbershop in Firestore, embeds it into Pinecone with the
// expanded metadata schema, runs the manifesto headline query
// ("buzz cut under $15 in Chinatown with a TV"), asserts the right shop comes
// back with the right matchedOn breadcrumbs, then cleans up.

import { getDb } from "../netlify/functions/lib/db.js";
import { upsertMemberVector, deleteMemberVectors } from "../netlify/functions/lib/vectorSearch.js";
import { searchMembers } from "../netlify/functions/lib/search.js";

const TEST_PREFIX = "test_e2e_struct_";

function ts() { return new Date().toISOString(); }
function log(...a) { console.log("[e2e]", ...a); }

const fixtures = [
  {
    id: `${TEST_PREFIX}chinatown_barber`,
    profile: {
      name: "Test Chinatown Barber",
      memberType: "vendor",
      category: "barbershop",
      city: "san francisco",
      neighborhood: "chinatown",
      priceRange: "$10–$25",
      priceMin: 10,
      priceMax: 25,
      pricePerProduct: [
        { name: "buzz cut", price: 12 },
        { name: "fade", price: 25 },
        { name: "beard trim", price: 10 },
      ],
      amenities: ["tv", "wifi"],
      atmosphere: ["neighborhood spot"],
      businessDescription: "Old-school neighborhood barbershop in Chinatown, classic cuts, TV always on.",
      onboardingComplete: true,
    },
  },
  {
    id: `${TEST_PREFIX}expensive_barber`,
    profile: {
      name: "Test Expensive Barber",
      memberType: "vendor",
      category: "barbershop",
      city: "san francisco",
      neighborhood: "chinatown",
      priceRange: "$30–$60",
      priceMin: 30,
      priceMax: 60,
      pricePerProduct: [
        { name: "fade", price: 35 },
        { name: "premium cut", price: 45 },
      ],
      amenities: ["tv"],
      atmosphere: ["upscale"],
      businessDescription: "Upscale Chinatown barber, premium cuts only, no buzz cuts.",
      onboardingComplete: true,
    },
  },
  {
    id: `${TEST_PREFIX}wrong_hood_barber`,
    profile: {
      name: "Test Mission Barber",
      memberType: "vendor",
      category: "barbershop",
      city: "san francisco",
      neighborhood: "mission",
      priceRange: "$10–$25",
      priceMin: 10,
      priceMax: 25,
      pricePerProduct: [
        { name: "buzz cut", price: 12 },
      ],
      amenities: ["tv"],
      businessDescription: "Mission barbershop, cheap buzz cuts, TV.",
      onboardingComplete: true,
    },
  },
];

async function seed() {
  const db = getDb();
  log("Seeding", fixtures.length, "test members...");
  for (const f of fixtures) {
    await db.collection("members").doc(f.id).set({
      profile: f.profile,
      source: "e2e_test",
      lastActiveAt: ts(),
    }, { merge: true });
    await upsertMemberVector(f.id, f.profile);
    log("  seeded", f.id);
  }
  // Pinecone indexing is eventually-consistent — give it a moment.
  log("Waiting 4s for Pinecone to index...");
  await new Promise(r => setTimeout(r, 4000));
}

async function cleanup() {
  log("Cleaning up...");
  const db = getDb();
  const ids = fixtures.map(f => f.id);
  await deleteMemberVectors(ids);
  for (const id of ids) {
    try { await db.collection("members").doc(id).delete(); } catch (e) { log("  firestore cleanup warn:", e.message); }
  }
  log("  done");
}

function assertOk(cond, msg) {
  if (!cond) {
    console.error("\n❌ ASSERTION FAILED:", msg);
    process.exitCode = 1;
  } else {
    console.log("✅", msg);
  }
}

async function runQuery(label, opts) {
  log("---", label, "---");
  const res = await searchMembers(opts);
  log("intent:", JSON.stringify(res.intent.filters), "excludes:", JSON.stringify(res.intent.excludes));
  log("results:", res.results.length);
  res.results.forEach(r => {
    log("  ", r.id, "matchedOn:", r.matchedOn);
  });
  return res;
}

async function main() {
  await seed();
  try {
    // CASE 1: the manifesto headline query, intent-parsed from natural language.
    const r1 = await runQuery("Q1: 'buzz cut under $15 in Chinatown with a TV'", {
      query: "buzz cut under $15 in Chinatown with a TV",
      excludeIds: [], parseIntent: true, limit: 20,
    });
    const ids1 = r1.results.map(r => r.id);
    assertOk(ids1.includes(`${TEST_PREFIX}chinatown_barber`), "Q1 includes the $12 buzz cut Chinatown shop");
    assertOk(!ids1.includes(`${TEST_PREFIX}expensive_barber`), "Q1 excludes the $30+ no-buzz-cut Chinatown shop");
    assertOk(!ids1.includes(`${TEST_PREFIX}wrong_hood_barber`), "Q1 excludes the Mission shop (wrong neighborhood)");
    const winner1 = r1.results.find(r => r.id === `${TEST_PREFIX}chinatown_barber`);
    if (winner1) {
      assertOk(
        winner1.matchedOn.some(m => /buzz cut/i.test(m) && /12/.test(m)),
        "Q1 winner's matchedOn surfaces the per-product hit (buzz cut $12)"
      );
      assertOk(
        winner1.matchedOn.some(m => /tv/i.test(m)),
        "Q1 winner's matchedOn surfaces TV amenity"
      );
    }

    // CASE 2: structured-only query, no NL parsing. Tests filter pushdown directly.
    const r2 = await runQuery("Q2: structured-only filters", {
      query: "barbershop",
      filters: {
        neighborhood: "chinatown",
        product: "buzz cut",
        priceMax: 15,
        amenities: ["tv"],
      },
      parseIntent: false,
      limit: 20,
    });
    const ids2 = r2.results.map(r => r.id);
    assertOk(ids2.includes(`${TEST_PREFIX}chinatown_barber`), "Q2 (structured) includes the right shop");
    assertOk(!ids2.includes(`${TEST_PREFIX}expensive_barber`), "Q2 (structured) excludes the expensive shop");
    assertOk(!ids2.includes(`${TEST_PREFIX}wrong_hood_barber`), "Q2 (structured) excludes the Mission shop");

    // CASE 3: a price cap that nobody meets.
    const r3 = await runQuery("Q3: 'buzz cut under $5' should match nobody", {
      query: "barbershop chinatown",
      filters: { neighborhood: "chinatown", product: "buzz cut", priceMax: 5 },
      parseIntent: false,
    });
    const ids3 = r3.results.map(r => r.id);
    assertOk(
      !ids3.some(id => id.startsWith(TEST_PREFIX)),
      "Q3 returns no test shops (no buzz cut ≤ $5 exists)"
    );

    // CASE 4: relax to verify the Mission shop comes in when we drop neighborhood.
    const r4 = await runQuery("Q4: 'buzz cut under $15' (no neighborhood) → 2 shops", {
      query: "barbershop",
      filters: { product: "buzz cut", priceMax: 15 },
      parseIntent: false,
    });
    const ids4 = r4.results.map(r => r.id);
    assertOk(ids4.includes(`${TEST_PREFIX}chinatown_barber`), "Q4 includes Chinatown shop");
    assertOk(ids4.includes(`${TEST_PREFIX}wrong_hood_barber`), "Q4 includes Mission shop (no neighborhood filter)");
    assertOk(!ids4.includes(`${TEST_PREFIX}expensive_barber`), "Q4 still excludes the expensive shop");

  } finally {
    await cleanup();
  }

  if (process.exitCode === 1) {
    console.error("\n❌ E2E FAILED");
  } else {
    console.log("\n✅ E2E PASSED");
  }
}

main().catch(e => {
  console.error("FATAL:", e);
  cleanup().finally(() => process.exit(1));
});
