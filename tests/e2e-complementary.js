// End-to-end proof that COMPLEMENTARY matching works against the REAL stack
// (Pinecone offers/needs namespaces + OpenAI embeddings).
// Run via:  netlify dev:exec node tests/e2e-complementary.js
//
// Seeds three members:
//   - a cafe that NEEDS a muralist (and offers wall space)
//   - a muralist who OFFERS murals (and needs walls to paint)
//   - an unrelated decoy (tax accountant)
// Then asserts the cafe and muralist surface each other via queryComplementary
// (with the right direction), outranking the decoy, and that the higher-level
// findComplementaryMatches returns the muralist for the cafe. Cleans up after.

import { getDb } from "../netlify/functions/lib/db.js";
import { upsertMemberVector, deleteMemberVectors, queryComplementary } from "../netlify/functions/lib/vectorSearch.js";
import { findComplementaryMatches } from "../netlify/functions/lib/recommend.js";

const TEST_PREFIX = "test_e2e_comp_";
const CAFE = `${TEST_PREFIX}cafe`;
const MURALIST = `${TEST_PREFIX}muralist`;
const DECOY = `${TEST_PREFIX}decoy`;

function ts() { return new Date().toISOString(); }
function log(...a) { console.log("[e2e]", ...a); }

const fixtures = [
  {
    id: CAFE,
    profile: {
      name: "Test Mission Cafe",
      memberType: "vendor",
      category: "cafe",
      city: "san francisco",
      neighborhood: "mission",
      businessDescription: "Cozy neighborhood cafe with a big blank wall by the entrance.",
      needs: ["a muralist to paint our entrance wall", "local artists for in-store art"],
      offers: ["wall space for local artists", "free coffee for collaborators", "a venue for small events"],
      onboardingComplete: true,
    },
  },
  {
    id: MURALIST,
    profile: {
      name: "Test Muralist",
      memberType: "artist",
      discipline: "muralist",
      city: "san francisco",
      neighborhood: "mission",
      businessDescription: "Street-art muralist who paints large-scale custom murals for local businesses.",
      offers: ["live mural painting", "custom wall murals for businesses"],
      needs: ["walls and storefronts to paint", "businesses to commission murals"],
      onboardingComplete: true,
    },
  },
  {
    id: DECOY,
    profile: {
      name: "Test Tax Accountant",
      memberType: "vendor",
      category: "accounting",
      city: "san francisco",
      neighborhood: "mission",
      businessDescription: "Small-business tax preparation and bookkeeping services.",
      offers: ["tax preparation", "bookkeeping", "payroll services"],
      needs: ["more small-business clients", "referrals"],
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
  log("Waiting 5s for Pinecone (offers/needs namespaces) to index...");
  await new Promise(r => setTimeout(r, 5000));
}

async function cleanup() {
  log("Cleaning up...");
  const db = getDb();
  const ids = fixtures.map(f => f.id);
  await deleteMemberVectors(ids); // clears default + offers + needs namespaces
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

const cafeProfile = fixtures.find(f => f.id === CAFE).profile;
const muralistProfile = fixtures.find(f => f.id === MURALIST).profile;
const rankOf = (ranked, id) => ranked.findIndex(r => r.id === id);

async function main() {
  await seed();
  try {
    // --- Cafe's perspective: needs a muralist, offers wall space ---
    log("--- queryComplementary for the CAFE ---");
    const cafeRanked = await queryComplementary({
      needsText: cafeProfile.needs.join(". "),
      offersText: cafeProfile.offers.join(". "),
      excludeIds: [CAFE],
      limit: 50,
    });
    cafeRanked.filter(r => r.id.startsWith(TEST_PREFIX)).forEach(r =>
      log("  ", r.id, "score", r.score.toFixed(3), r.directions));

    const muralistHit = cafeRanked.find(r => r.id === MURALIST);
    assertOk(!!muralistHit, "Cafe's complementary search surfaces the muralist");
    assertOk(
      muralistHit?.directions.includes("they_offer_what_you_need"),
      "Muralist matched the cafe via 'they_offer_what_you_need' (muralist offers what cafe needs)"
    );
    const mRank = rankOf(cafeRanked, MURALIST);
    const dRank = rankOf(cafeRanked, DECOY);
    assertOk(
      mRank !== -1 && (dRank === -1 || mRank < dRank),
      `Muralist outranks the tax-accountant decoy for the cafe (muralist #${mRank}, decoy #${dRank})`
    );

    // --- Muralist's perspective: needs walls, offers murals ---
    log("--- queryComplementary for the MURALIST ---");
    const muralistRanked = await queryComplementary({
      needsText: muralistProfile.needs.join(". "),
      offersText: muralistProfile.offers.join(". "),
      excludeIds: [MURALIST],
      limit: 50,
    });
    muralistRanked.filter(r => r.id.startsWith(TEST_PREFIX)).forEach(r =>
      log("  ", r.id, "score", r.score.toFixed(3), r.directions));
    assertOk(
      muralistRanked.some(r => r.id === CAFE),
      "Muralist's complementary search surfaces the cafe (cafe offers the wall the muralist needs)"
    );

    // --- Higher-level integration: findComplementaryMatches loads profiles + directions ---
    log("--- findComplementaryMatches(cafe) ---");
    const matches = await findComplementaryMatches(CAFE, cafeProfile, { limit: 25 });
    const muralistMatch = matches.find(m => m.id === MURALIST);
    assertOk(!!muralistMatch, "findComplementaryMatches returns the muralist for the cafe");
    assertOk(
      !!muralistMatch?.profile?.name && Array.isArray(muralistMatch?.directions),
      "Returned match carries a loaded profile + directions"
    );
    assertOk(
      muralistMatch && muralistMatch.profile && muralistMatch.profile.phone === undefined,
      "Returned match strips phone"
    );
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
