// Imports rich legacy businesses from ProLocalIQ (Supabase) into Community
// Connector as `status: "unclaimed"` profiles, using GPT to extract structured
// fields (amenities, atmosphere, products, booleans, taxonomy) from the
// description + story prose.
//
// Run dry (no writes, prints what would happen):
//   netlify dev:exec node scripts/import-prolocaliq.mjs --dry --limit=5
// Run for real:
//   netlify dev:exec node scripts/import-prolocaliq.mjs --limit=394
//
// Source DB: SUPABASE_DATABASE_URL must be in env (we read it from the
// prolocaliq archive .env automatically if not set in the shell).

import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { getDb } from "../netlify/functions/lib/db.js";
import { upsertMemberVector } from "../netlify/functions/lib/vectorSearch.js";
import { normalizePricePerProduct } from "../netlify/functions/lib/priceParse.js";
import { TAXONOMY } from "../netlify/functions/lib/taxonomy.js";

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const limitArg = args.find(a => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : 5;
const offsetArg = args.find(a => a.startsWith("--offset="));
const OFFSET = offsetArg ? parseInt(offsetArg.split("=")[1], 10) : 0;
const randomMode = args.includes("--random");

// Pull the supabase URL from prolocaliq's .env if not in current env.
function loadProlocaliqEnv() {
  if (process.env.SUPABASE_DATABASE_URL) return;
  const candidate = path.join(process.env.HOME, "Desktop/dev/archive/prolocaliq/.env");
  if (!fs.existsSync(candidate)) return;
  const lines = fs.readFileSync(candidate, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^SUPABASE_DATABASE_URL=(.+)$/);
    if (m) {
      process.env.SUPABASE_DATABASE_URL = m[1].replace(/^['"]|['"]$/g, "");
      return;
    }
  }
}
loadProlocaliqEnv();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TAXONOMY_VENDOR = TAXONOMY.vendor;
const TAXONOMY_PROMPT = Object.entries(TAXONOMY_VENDOR)
  .map(([cat, subs]) => `  ${cat}: ${subs.join(", ")}`)
  .join("\n");

const EXTRACT_SYSTEM = `You are extracting structured business attributes from a legacy directory listing. The descriptions are real, hand-written prose — extract everything they support. Be GENEROUS in extracting fields the text supports (even loosely), but NEVER invent attributes that aren't mentioned. The goal is to populate as many fields as the prose justifies.

Source fields you'll receive: name, description, story, address, neighborhood, city, phone, website, hours, source_category.

Return a JSON object with the fields below. Populate every field the prose supports — don't leave arrays empty if the description mentions relevant things. Convert evocative adjectives ("vibrant", "historic", "cozy", "lively", "rustic", "intimate") into atmosphere entries. Convert nouns of things sold ("jewelry", "metal art", "kites", "Bloody Marys") into products. Convert verbs of things offered ("repairs", "installs windows", "hosts comedy shows") into services. Convert founding year mentions into founded + yearsInBusiness.

Schema (omit anything you can't infer):
- category: one of EXACTLY: ${Object.keys(TAXONOMY_VENDOR).join(" | ")}. Use the closest match — do NOT invent new categories.
- subcategory: EXACT match from the list below for the chosen category. If nothing fits, pick the CLOSEST existing one — never invent a new subcategory. (e.g. a pet store with no exact match → Retail / Home Goods; a grocery store → Retail / Home Goods; a private community club → Services / Event Rental; a community arts org → Arts & Crafts / Gallery.)
${TAXONOMY_PROMPT}
- amenities: lowercase array (e.g. ["live music","outdoor seating","wifi","pool table","tv","fireplace","parking","wheelchair accessible","dance floor"])
- atmosphere: lowercase array (e.g. ["lively","intimate","dive bar","upscale","neighborhood spot","date night","family friendly","historic"])
- vibe: short string capturing the feel (e.g. "old-school SF dive with punk roots")
- products: array of specific items they sell
- services: array of specific services they offer
- featuredProduct: single standout item if mentioned
- priceRange: string if mentioned ("Under $25", "Affordable", "$$", "$10-$30")
- priceMin: number (USD) if mentioned
- priceMax: number (USD) if mentioned
- pricePerProduct: array of {name, price} only if specific menu prices given
- yearsInBusiness: integer if mentioned
- founded: 4-digit year if mentioned ("since 1956" → 1956)
- acceptsEBT, acceptsCash, acceptsCrypto, wheelchairAccessible, freeParking: boolean if explicitly mentioned
- openLate, open24Hours, openWeekends: boolean if mentioned
- veganOptions, vegetarianOptions, glutenFree, halalCertified, kosher, byob, fullBar: boolean if mentioned
- sportsBar, watchParties: boolean if mentioned
- favoriteTeams: array if mentioned
- values: lowercase array for owner identity / mission tags (e.g. ["lgbtq-owned","black-owned","family-owned","woman-owned","veteran-owned","queer-owned"])
- specialties: array of what they're known for
- approvedBlurb: a polished 1-2 sentence community-facing blurb based on the source text

RULES:
- Don't fabricate. If TV isn't mentioned, don't add it. Booleans only when explicitly stated.
- DO extract synonyms and inferences from prose. "Live music every night" → amenities:["live music"], openLate:true. "Beer garden" → atmosphere:["lively"], amenities:["outdoor seating"]. "Family-owned since 1948" → values:["family-owned"], founded:1948. "Specialty kite shop" → products:["kites"]. "Best Comedy Club" + "six nights a week" → openLate:true.
- For SOURCE-CATEGORY "General" or anything ambiguous, infer the right canonical category from the prose. A bar should NOT be Services. A retailer of carpets should be Retail/Home Goods. A jewelry maker is Arts & Crafts/Jewelry.
- always set "memberType" implicitly as vendor (we handle that elsewhere).

EXAMPLE — INPUT:
"DNA Lounge has been one of San Francisco's most popular nightclubs since 1985, hosting an always-eclectic variety of events, including all-ages live music, 18+ dance parties, burlesque shows, lecture series, and private parties. DNA Lounge consists of two stages, four dance floors, seven bars, and a full-service late-night restaurant and cafe!"

EXAMPLE — OUTPUT:
{
  "category": "Food & Beverage",
  "subcategory": "Bar",
  "vibe": "eclectic SF nightclub since 1985",
  "amenities": ["live music", "dance floor", "two stages", "seven bars", "late-night restaurant"],
  "atmosphere": ["lively", "eclectic", "iconic"],
  "services": ["all-ages live music", "18+ dance parties", "burlesque shows", "lecture series", "private parties"],
  "fullBar": true,
  "openLate": true,
  "founded": 1985,
  "yearsInBusiness": 40,
  "approvedBlurb": "DNA Lounge — one of SF's most eclectic nightclubs since 1985, with multiple stages, four dance floors, seven bars, and a late-night kitchen."
}`;

async function extract(business) {
  const userMsg = `name: ${business.name}
description: ${business.description || ""}
story: ${business.story || ""}
source_category: ${business.category || ""}
address: ${business.address || ""}
neighborhood: ${business.neighborhood || ""}
city: ${business.city || ""}
hours: ${business.hours || ""}
phone: ${business.phone || ""}
website: ${business.website || ""}`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 800,
    messages: [
      { role: "system", content: EXTRACT_SYSTEM },
      { role: "user", content: userMsg },
    ],
    response_format: { type: "json_object" },
    temperature: 0.2,
  });
  try {
    return JSON.parse(completion.choices[0].message.content);
  } catch {
    return {};
  }
}

function buildProfile(business, extracted) {
  const p = {
    name: business.name,
    memberType: "vendor",
    source: "prolocaliq_import",
    sourceId: business.id,
    onboardingComplete: true,
    // identity from source
    address: business.address || undefined,
    phone: business.phone || undefined,
    websiteUrl: business.website || undefined,
    email: business.email || undefined,
    neighborhood: business.neighborhood || extracted.neighborhood || undefined,
    city: business.city || undefined,
    state: business.state || undefined,
    latitude: business.latitude != null ? Number(business.latitude) : undefined,
    longitude: business.longitude != null ? Number(business.longitude) : undefined,
    businessHours: business.hours || undefined,
    imageUrl: business.image_url || undefined,
    businessDescription: business.description || undefined,
    story: business.story || undefined,
  };

  const passthroughKeys = [
    "category", "subcategory", "amenities", "atmosphere", "vibe",
    "products", "services", "featuredProduct", "priceRange", "priceMin", "priceMax",
    "yearsInBusiness", "founded",
    "acceptsEBT", "acceptsCash", "acceptsCrypto", "wheelchairAccessible", "freeParking",
    "openLate", "open24Hours", "openWeekends",
    "veganOptions", "vegetarianOptions", "glutenFree", "halalCertified", "kosher", "byob", "fullBar",
    "sportsBar", "watchParties", "favoriteTeams",
    "values", "specialties", "approvedBlurb",
  ];
  for (const k of passthroughKeys) {
    if (extracted[k] !== undefined && extracted[k] !== null && !(Array.isArray(extracted[k]) && extracted[k].length === 0)) {
      p[k] = extracted[k];
    }
  }
  // Enforce canonical taxonomy: drop invented subcategories, keep category if it's in the list.
  if (p.category && !Object.keys(TAXONOMY_VENDOR).includes(p.category)) {
    delete p.category; delete p.subcategory;
  } else if (p.subcategory && p.category && !(TAXONOMY_VENDOR[p.category] || []).includes(p.subcategory)) {
    delete p.subcategory;
  }
  if (extracted.pricePerProduct) {
    const ppp = normalizePricePerProduct(extracted.pricePerProduct);
    if (ppp.length) p.pricePerProduct = ppp;
  }
  // Remove undefined keys for clean Firestore writes.
  for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k];
  return p;
}

async function main() {
  console.log(`[import-prolocaliq] ${DRY ? "DRY RUN" : "LIVE WRITE"} · limit=${LIMIT}`);
  if (!process.env.SUPABASE_DATABASE_URL) { console.error("missing SUPABASE_DATABASE_URL"); process.exit(1); }

  const c = new pg.Client({ connectionString: process.env.SUPABASE_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  // Quality filter — substantive description and not test garbage.
  const { rows } = await c.query(`
    WITH x AS (
      SELECT *,
        length(description) AS d_len,
        array_length(array(SELECT DISTINCT w FROM regexp_split_to_table(lower(description), '\\s+') w WHERE w <> ''), 1) AS d_uniq
      FROM businesses
      WHERE deleted IS NOT TRUE
        AND description IS NOT NULL
        AND description <> ''
    )
    SELECT id, name, category, description, story, address, neighborhood, city, state,
           phone, website, email, hours, latitude, longitude, image_url
    FROM x
    WHERE d_uniq >= 15 AND d_len >= 200
    ORDER BY ${randomMode ? "random()" : "d_uniq DESC"}
    LIMIT $1 OFFSET $2
  `, [LIMIT, OFFSET]);

  console.log(`[source] selected ${rows.length} businesses`);

  let writes = 0, skipped = 0;
  const db = !DRY ? getDb() : null;

  for (const b of rows) {
    const docId = `pliq_${b.id}`;
    console.log("\n=====", b.id, "·", b.name, "=====");
    console.log("source neighborhood/city:", b.neighborhood || "—", "/", b.city || "—");
    console.log("source description:", (b.description || "").slice(0, 200) + "…");

    const extracted = await extract(b);
    const profile = buildProfile(b, extracted);

    console.log("\n  extracted →");
    console.log("    category/subcategory:", profile.category || "—", "/", profile.subcategory || "—");
    console.log("    vibe:", profile.vibe || "—");
    console.log("    amenities:", profile.amenities || []);
    console.log("    atmosphere:", profile.atmosphere || []);
    console.log("    products:", profile.products || []);
    console.log("    services:", profile.services || []);
    console.log("    priceRange:", profile.priceRange || "—", "| priceMin/Max:", profile.priceMin ?? "—", "/", profile.priceMax ?? "—");
    console.log("    values:", profile.values || []);
    console.log("    booleans:", Object.fromEntries(
      ["openLate","sportsBar","veganOptions","wheelchairAccessible","fullBar","byob","watchParties","acceptsCash","acceptsEBT","kidsFriendly"]
        .filter(k => profile[k] != null).map(k => [k, profile[k]])
    ));
    console.log("    founded:", profile.founded || "—", "| yearsInBusiness:", profile.yearsInBusiness || "—");
    if (profile.approvedBlurb) console.log("    blurb:", profile.approvedBlurb);

    if (DRY) { skipped++; continue; }

    // LIVE — write member + subscriptions/etc. structure.
    try {
      await db.collection("members").doc(docId).set({
        profile,
        source: "prolocaliq_import",
        status: "unclaimed",
        lastActiveAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      }, { merge: true });
      await upsertMemberVector(docId, { ...profile, unclaimed: true, status: "unclaimed" });
      writes++;
      console.log("  ✅ wrote", docId);
    } catch (e) {
      console.error("  ❌ write failed:", e.message);
    }
  }

  await c.end();
  console.log(`\n[done] writes=${writes} skipped(dry)=${skipped}`);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
