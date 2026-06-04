// Fetch coordinates for every Firestore member missing profile.latitude.
// Queries Places API New ("places.googleapis.com/v1/places:searchText") with
// the member's name + city + state. Writes ALL results to a local JSON file
// (scripts/geocode-results.json) so you can review/edit before applying.
//
// NO Firestore writes. Pair with geocode-apply.mjs to actually persist.
//
// Run:
//   netlify dev:exec -- node scripts/geocode-fetch.mjs
//   netlify dev:exec -- node scripts/geocode-fetch.mjs --limit=20      (test small)
//   netlify dev:exec -- node scripts/geocode-fetch.mjs --include-existing  (also re-geocode ones that already have lat/lng)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../netlify/functions/lib/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUT_PATH = path.join(__dirname, "geocode-results.json");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  })
);
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const INCLUDE_EXISTING = !!args["include-existing"];

const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
if (!API_KEY) {
  console.error("Missing GOOGLE_PLACES_API_KEY in env");
  process.exit(1);
}

async function searchTextOnce(query) {
  const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": API_KEY,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.formattedAddress,places.addressComponents,places.location,places.types",
    },
    body: JSON.stringify({ textQuery: query, languageCode: "en" }),
  });
  const d = await r.json();
  if (d.error) return { _error: d.error.status, _msg: d.error.message };
  const p = (d.places || [])[0];
  if (!p) return { _error: "ZERO_RESULTS" };
  return p;
}

async function searchText(query) {
  // Google sporadically returns INVALID_ARGUMENT / "API key expired" while
  // the same key keeps working seconds later — treat as transient and retry.
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await searchTextOnce(query);
    if (!r._error || r._error === "ZERO_RESULTS") return r;
    if (attempt === 2) return r;
    await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
  }
}

function pickComponent(components, type) {
  if (!Array.isArray(components)) return undefined;
  const c = components.find((x) => (x.types || []).includes(type));
  return c?.longText || c?.shortText || undefined;
}

async function main() {
  const db = getDb();
  console.log("Loading members from Firestore…");
  const snap = await db.collection("members").get();
  const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  console.log(`Total members: ${all.length}`);

  const needsGeocode = all.filter((m) => {
    const p = m.profile || {};
    if (!p.name && !p.businessName) return false;
    if (INCLUDE_EXISTING) return true;
    return p.latitude == null || p.longitude == null;
  }).slice(0, LIMIT);

  console.log(`To geocode: ${needsGeocode.length}\n`);

  const results = [];
  let okCount = 0, errCount = 0, outOfSF = 0;

  for (let i = 0; i < needsGeocode.length; i++) {
    const m = needsGeocode[i];
    const p = m.profile || {};
    const name = p.name || p.businessName;
    const city = p.city || "San Francisco";
    const state = p.state || "CA";
    const query = `${name}, ${city}, ${state}`;

    process.stdout.write(`[${i + 1}/${needsGeocode.length}] ${m.id} · ${name} … `);
    const r = await searchText(query);

    if (r._error) {
      console.log(`❌ ${r._error}`);
      results.push({ id: m.id, name, query, status: r._error, message: r._msg });
      errCount++;
      continue;
    }

    const lat = r.location?.latitude;
    const lng = r.location?.longitude;
    const formattedAddress = r.formattedAddress;
    const matchedName = r.displayName?.text;
    const placeId = r.id;
    const inSF = (formattedAddress || "").toLowerCase().includes("san francisco");
    if (!inSF) outOfSF++;

    results.push({
      id: m.id,
      name,
      query,
      status: "OK",
      placeId,
      matchedName,
      formattedAddress,
      latitude: lat,
      longitude: lng,
      city: pickComponent(r.addressComponents, "locality"),
      state: pickComponent(r.addressComponents, "administrative_area_level_1"),
      neighborhood:
        pickComponent(r.addressComponents, "neighborhood") ||
        pickComponent(r.addressComponents, "sublocality_level_1") ||
        pickComponent(r.addressComponents, "sublocality"),
      postalCode: pickComponent(r.addressComponents, "postal_code"),
      types: r.types || [],
      inSF,
    });
    okCount++;
    console.log(`✓ ${matchedName} · ${lat?.toFixed(4)}, ${lng?.toFixed(4)}${inSF ? "" : "  ⚠️  not SF"}`);

    // Stay polite — Places New SearchText is fast but no need to hammer
    await new Promise((res) => setTimeout(res, 80));
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  console.log(`\nSaved ${results.length} entries to ${OUT_PATH}`);
  console.log(`Summary: ${okCount} ok · ${errCount} errors · ${outOfSF} matched outside San Francisco`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
