// Dry-run probe: pulls a handful of Firestore members without coordinates,
// queries Google Places "findplacefromtext" by name + city, prints the result
// for manual review. NO writes — once you're happy with the matches, we'll
// promote this to a real backfill.
//
// Run:
//   netlify dev:exec -- node scripts/test-geocode.mjs            (5 members)
//   netlify dev:exec -- node scripts/test-geocode.mjs --n=10     (10 members)
//   netlify dev:exec -- node scripts/test-geocode.mjs --id=pliq_139,pliq_123  (specific IDs)

import { getDb } from "../netlify/functions/lib/db.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  })
);
const N = args.n ? Number(args.n) : 5;
const explicitIds = typeof args.id === "string" ? args.id.split(",") : null;

const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
if (!API_KEY) {
  console.error("Missing GOOGLE_PLACES_API_KEY in env");
  process.exit(1);
}

async function findPlace(query) {
  const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": API_KEY,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location",
    },
    body: JSON.stringify({ textQuery: query, languageCode: "en" }),
  });
  const d = await r.json();
  if (d.error) return { _error: d.error.status, _msg: d.error.message };
  const p = (d.places || [])[0];
  if (!p) return { _error: "ZERO_RESULTS" };
  return {
    place_id: p.id,
    name: p.displayName?.text,
    formatted_address: p.formattedAddress,
    geometry: { location: { lat: p.location?.latitude, lng: p.location?.longitude } },
  };
}

async function main() {
  const db = getDb();
  let docs;
  if (explicitIds) {
    docs = await Promise.all(explicitIds.map((id) => db.collection("members").doc(id.trim()).get()));
    docs = docs.filter((d) => d.exists);
  } else {
    // Pull a batch, filter to ones missing coordinates client-side (no compound
    // index needed). Pull more than N so the filter has room.
    const snap = await db.collection("members").limit(200).get();
    docs = snap.docs.filter((d) => {
      const p = d.data().profile || {};
      return p.latitude == null || p.longitude == null;
    }).slice(0, N);
  }

  console.log(`Testing ${docs.length} member(s) — read-only.\n`);

  for (const doc of docs) {
    const m = doc.data();
    const p = m.profile || {};
    const name = p.name || p.businessName || "(no name)";
    const city = p.city || "San Francisco";
    const state = p.state || "CA";
    const query = `${name}, ${city}, ${state}`;

    console.log(`[${doc.id}] ${name}`);
    console.log(`  query: ${query}`);
    const r = await findPlace(query);
    if (r._error) {
      console.log(`  ❌ ${r._error}${r._msg ? " — " + r._msg : ""}`);
    } else {
      const loc = r.geometry?.location || {};
      const inSF = (r.formatted_address || "").toLowerCase().includes("san francisco");
      console.log(`  ✓ ${r.name}`);
      console.log(`  address: ${r.formatted_address}`);
      console.log(`  coords:  ${loc.lat}, ${loc.lng}    ${inSF ? "" : "⚠️  not in SF"}`);
      console.log(`  place_id: ${r.place_id}`);
    }
    console.log();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
