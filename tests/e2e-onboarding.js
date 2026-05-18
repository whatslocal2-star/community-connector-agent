// End-to-end proof that the onboarding agent captures structured fields.
// Drives the REAL chat handler with a scripted barbershop conversation,
// then reads the Firestore profile and asserts the new fields are populated.
//
// Run via:  netlify dev:exec node tests/e2e-onboarding.js

import { handler as chatHandler } from "../netlify/functions/chat.js";
import { getDb, loadMember } from "../netlify/functions/lib/db.js";
import { deleteMemberVectors } from "../netlify/functions/lib/vectorSearch.js";

const SESSION_ID = `test_e2e_onboard_${Date.now()}`;
const log = (...a) => console.log("[onboard-e2e]", ...a);

function assertOk(cond, msg, ctx) {
  if (!cond) {
    console.error("❌", msg);
    if (ctx !== undefined) console.error("   actual:", JSON.stringify(ctx));
    process.exitCode = 1;
  } else {
    console.log("✅", msg);
  }
}

async function sendTurn(messages) {
  const event = {
    httpMethod: "POST",
    headers: {},
    body: JSON.stringify({ sessionId: SESSION_ID, messages }),
  };
  const res = await chatHandler(event);
  if (res.statusCode !== 200) {
    throw new Error(`chat handler returned ${res.statusCode}: ${res.body}`);
  }
  const { reply } = JSON.parse(res.body);
  return reply;
}

async function cleanup() {
  log("Cleaning up", SESSION_ID);
  try { await getDb().collection("members").doc(SESSION_ID).delete(); } catch (e) { log("  firestore cleanup warn:", e.message); }
  await deleteMemberVectors([SESSION_ID]);
}

async function main() {
  log("Starting onboarding simulation for", SESSION_ID);

  // Speed-onboarding: dump everything in one message so the agent has to extract
  // EVERY structured field in a single turn. This is the toughest test for the
  // system prompt's structured-capture rules.
  const opener = [
    {
      role: "user",
      content: `Hey! I'm Marcus, joining as a vendor. I run a classic neighborhood barbershop in Chinatown, San Francisco. Our prices are $10 to $25 — buzz cut is $12, fade is $25, beard trim is $10, hot towel shave is $20. We have a TV showing sports, wifi, and we're dog friendly. We also have outdoor seating out back. We accept EBT and cash. We're a chill neighborhood spot, open late on Fridays. Email is marcus@chinatowncuts.com.`
    }
  ];
  const reply1 = await sendTurn(opener);
  log("Agent reply 1:", reply1.slice(0, 200));

  // 2nd turn — confirm everything is captured. Mirrors how a real user would
  // respond if the agent ignored some of the opener data.
  const turn2 = [
    ...opener,
    { role: "assistant", content: reply1 },
    { role: "user", content: "I told you my email already — marcus@chinatowncuts.com. Just confirm you've got everything." },
  ];
  const reply2 = await sendTurn(turn2);
  log("Agent reply 2:", reply2.slice(0, 200));

  // Give the post-save normalization a moment.
  await new Promise(r => setTimeout(r, 500));

  const member = await loadMember(SESSION_ID);
  if (!member?.profile) {
    console.error("❌ FATAL: no profile saved");
    process.exitCode = 1;
    return;
  }
  const p = member.profile;
  log("Saved profile keys:", Object.keys(p).join(", "));
  log("Full profile:", JSON.stringify(p, null, 2));

  // Core identity
  assertOk(p.memberType === "vendor", "memberType = vendor", p.memberType);
  assertOk(/marcus/i.test(p.name || ""), "name captured", p.name);

  // Location
  assertOk(/chinatown/i.test(p.neighborhood || ""), "neighborhood = Chinatown", p.neighborhood);
  assertOk(/san francisco|sf/i.test(p.city || ""), "city = San Francisco", p.city);

  // Price range → numeric normalization
  assertOk(typeof p.priceMin === "number" && p.priceMin === 10, "priceMin parsed to 10", p.priceMin);
  assertOk(typeof p.priceMax === "number" && p.priceMax === 25, "priceMax parsed to 25", p.priceMax);

  // Per-product pricing — the manifesto headline field
  assertOk(Array.isArray(p.pricePerProduct) && p.pricePerProduct.length >= 3,
    "pricePerProduct captured (≥3 items)", p.pricePerProduct);
  if (Array.isArray(p.pricePerProduct)) {
    const buzz = p.pricePerProduct.find(x => /buzz\s*cut/i.test(x?.name || ""));
    assertOk(buzz && Number(buzz.price) === 12, "buzz cut → $12", buzz);
    const fade = p.pricePerProduct.find(x => /fade/i.test(x?.name || ""));
    assertOk(fade && Number(fade.price) === 25, "fade → $25", fade);
    const beard = p.pricePerProduct.find(x => /beard/i.test(x?.name || ""));
    assertOk(beard && Number(beard.price) === 10, "beard trim → $10", beard);
  }

  // Amenities — lowercase array per prompt rules
  assertOk(Array.isArray(p.amenities) && p.amenities.length >= 2,
    "amenities array populated", p.amenities);
  if (Array.isArray(p.amenities)) {
    const a = p.amenities.map(x => String(x).toLowerCase());
    assertOk(a.some(x => x.includes("tv")), "amenities contains tv", a);
    assertOk(a.some(x => x.includes("wifi")), "amenities contains wifi", a);
    assertOk(a.some(x => x.includes("dog")), "amenities contains dog friendly", a);
    assertOk(a.some(x => x.includes("outdoor")), "amenities contains outdoor seating", a);
  }

  // Booleans
  assertOk(p.acceptsEBT === true, "acceptsEBT = true", p.acceptsEBT);
  assertOk(p.acceptsCash === true, "acceptsCash = true", p.acceptsCash);
  assertOk(p.openLate === true, "openLate = true", p.openLate);

  // Email
  assertOk(/marcus@chinatowncuts\.com/i.test(p.email || ""), "email captured", p.email);
}

main()
  .catch(e => { console.error("FATAL:", e); process.exitCode = 1; })
  .finally(async () => {
    await cleanup();
    console.log(process.exitCode === 1 ? "\n❌ ONBOARDING E2E FAILED" : "\n✅ ONBOARDING E2E PASSED");
  });
