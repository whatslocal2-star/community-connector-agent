// Reads scripts/geocode-results.json (produced by geocode-fetch.mjs) and
// writes the coordinates back to each Firestore member doc.
//
// Defaults to DRY RUN — pass --apply to actually write. Skips entries with
// status != "OK" and (by default) entries that matched outside San Francisco.
//
// Run:
//   netlify dev:exec -- node scripts/geocode-apply.mjs              (dry run)
//   netlify dev:exec -- node scripts/geocode-apply.mjs --apply      (live)
//   netlify dev:exec -- node scripts/geocode-apply.mjs --apply --include-outside-sf

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// Load Firebase admin from a service-account JSON file rather than the env-var
// path used by the Netlify functions — keeps this script self-contained and
// independent of CLI context resolution. Override via FIREBASE_SERVICE_ACCOUNT.
const SA_PATH =
  process.env.FIREBASE_SERVICE_ACCOUNT ||
  "/Users/xen/Desktop/dev/Code/whatlocal-ab06e-firebase-adminsdk-fbsvc-ea5d0acc54.json";

function getDb() {
  if (!getApps().length) {
    const sa = JSON.parse(fs.readFileSync(SA_PATH, "utf8"));
    initializeApp({ credential: cert(sa) });
  }
  return getFirestore();
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const IN_PATH = path.join(__dirname, "geocode-results.json");

const args = new Set(process.argv.slice(2));
const APPLY = args.has("--apply");
const INCLUDE_OUTSIDE_SF = args.has("--include-outside-sf");

async function main() {
  if (!fs.existsSync(IN_PATH)) {
    console.error(`Missing ${IN_PATH} — run geocode-fetch.mjs first.`);
    process.exit(1);
  }
  const { results } = JSON.parse(fs.readFileSync(IN_PATH, "utf8"));
  console.log(`Loaded ${results.length} results.  ${APPLY ? "LIVE" : "DRY RUN"}\n`);

  const eligible = results.filter((r) => {
    if (r.status !== "OK") return false;
    if (!INCLUDE_OUTSIDE_SF && !r.inSF) return false;
    if (typeof r.latitude !== "number" || typeof r.longitude !== "number") return false;
    return true;
  });
  const skipped = results.length - eligible.length;
  console.log(`Eligible to write: ${eligible.length}   Skipped: ${skipped}\n`);

  const db = getDb();
  let written = 0, errors = 0;

  for (let i = 0; i < eligible.length; i++) {
    const r = eligible[i];
    const ref = db.collection("members").doc(r.id);
    const snap = await ref.get();
    if (!snap.exists) {
      console.log(`[${i + 1}/${eligible.length}] ${r.id} · MISSING DOC — skip`);
      errors++;
      continue;
    }
    const existing = snap.data().profile || {};

    // Always overwrite latitude/longitude with Google's value (that's the
    // whole point). For text fields (city/state/neighborhood/address), only
    // fill if the existing value is missing — don't clobber human-entered data.
    const patch = {
      "profile.latitude": r.latitude,
      "profile.longitude": r.longitude,
      "profile.placeId": r.placeId,
    };
    if (!existing.city && r.city) patch["profile.city"] = r.city;
    if (!existing.state && r.state) patch["profile.state"] = r.state;
    if (!existing.neighborhood && r.neighborhood) patch["profile.neighborhood"] = r.neighborhood;
    if (!existing.address && r.formattedAddress) patch["profile.address"] = r.formattedAddress;

    if (APPLY) {
      try {
        await ref.update(patch);
        written++;
        console.log(`[${i + 1}/${eligible.length}] ${r.id} · ${r.name?.slice(0, 30) || ""}  → ${r.latitude.toFixed(4)}, ${r.longitude.toFixed(4)}`);
      } catch (e) {
        errors++;
        console.log(`[${i + 1}/${eligible.length}] ${r.id} · ERROR: ${e.message}`);
      }
    } else {
      console.log(`[${i + 1}/${eligible.length}] ${r.id} · ${r.name?.slice(0, 30) || ""}  → ${r.latitude.toFixed(4)}, ${r.longitude.toFixed(4)}   ${Object.keys(patch).filter((k) => k !== "profile.latitude" && k !== "profile.longitude" && k !== "profile.placeId").join(", ") || "(coords only)"}`);
    }
  }

  console.log(`\n${APPLY ? "WROTE" : "WOULD WRITE"}: ${APPLY ? written : eligible.length}   Errors: ${errors}`);
  if (!APPLY) console.log("Re-run with --apply to commit.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
