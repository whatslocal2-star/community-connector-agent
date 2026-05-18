// Backfill imported member images from the prolocaliq DigitalOcean Spaces
// bucket. Sets public-read ACL on each "businesses/<id>-*" object so the
// marketplace UI can render them directly, then writes profile.imageUrl
// (single) + profile.images[] (full array) onto each pliq_<id> Firestore doc.
//
// Run via:
//   netlify dev:exec -- node scripts/backfill-images-from-spaces.mjs --dry   (no changes)
//   netlify dev:exec -- node scripts/backfill-images-from-spaces.mjs         (live)

import fs from "node:fs";
import path from "node:path";
import { S3Client, ListObjectsV2Command, PutObjectAclCommand } from "@aws-sdk/client-s3";
import { getDb, loadAllMembers } from "../netlify/functions/lib/db.js";

const DRY = process.argv.includes("--dry");

// Spaces creds live in the prolocaliq archive .env.
function loadSpacesEnv() {
  if (process.env.AWS_ACCESS_KEY_ID && process.env.SPACES_BUCKET) return;
  const candidate = path.join(process.env.HOME, "Desktop/dev/archive/prolocaliq/.env");
  if (!fs.existsSync(candidate)) return;
  const lines = fs.readFileSync(candidate, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^(SPACES_BUCKET|AWS_ENDPOINT|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
}
loadSpacesEnv();

const endpoint = process.env.AWS_ENDPOINT;
const bucket = process.env.SPACES_BUCKET;
const region = endpoint?.match(/\/\/([^.]+)\./)?.[1] || "nyc3";
const publicHost = `${bucket}.${region}.digitaloceanspaces.com`;

const s3 = new S3Client({
  endpoint, region,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

async function listAllUnderPrefix(prefix) {
  let keys = [], token;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 }));
    keys = keys.concat((r.Contents || []).map(o => o.Key));
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

function imageUrlFor(key) { return `https://${publicHost}/${key}`; }

async function main() {
  console.log(`[backfill-images] ${DRY ? "DRY RUN" : "LIVE"} · bucket=${bucket}`);

  // 1. Enumerate every key under businesses/
  console.log("listing businesses/* …");
  const allKeys = await listAllUnderPrefix("businesses/");
  const filteredKeys = allKeys.filter(k => /\.(jpe?g|png|webp|gif)$/i.test(k));
  console.log(`  found ${filteredKeys.length} image keys`);

  // 2. Group by leading numeric id (the businesses/<id>-... pattern)
  const byId = new Map();
  for (const k of filteredKeys) {
    const m = k.match(/^businesses\/(\d+)-/);
    if (!m) continue;
    const id = m[1];
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(k);
  }
  // Stable order — businesses/<id>-Name-1.jpg before -2.jpg
  for (const arr of byId.values()) arr.sort();
  console.log(`  grouped into ${byId.size} distinct business ids`);

  // 3. Load CC members and intersect with pliq_<id>
  const members = await loadAllMembers(2000);
  const pliq = members.filter(m => m.id.startsWith("pliq_"));
  console.log(`  ${pliq.length} pliq_* members in Firestore`);

  const targets = [];
  for (const m of pliq) {
    const id = m.id.slice(5); // strip pliq_
    const keys = byId.get(id);
    if (!keys?.length) continue;
    targets.push({ member: m, id, keys });
  }
  console.log(`  ${targets.length} members have matching Spaces images\n`);

  if (DRY) {
    for (const t of targets.slice(0, 8)) {
      console.log(`  ${t.member.id}  ${t.member.profile?.name?.slice(0, 36) || ""}`);
      for (const k of t.keys) console.log("    →", imageUrlFor(k));
    }
    console.log(`\n[dry] would patch ${targets.length} members and set public-read ACL on ${targets.reduce((a, t) => a + t.keys.length, 0)} objects.`);
    return;
  }

  // 4. Set public-read ACL on every needed key (cheap, idempotent)
  console.log("setting public-read ACL on objects …");
  let aclOk = 0, aclFail = 0;
  for (const t of targets) {
    for (const Key of t.keys) {
      try {
        await s3.send(new PutObjectAclCommand({ Bucket: bucket, Key, ACL: "public-read" }));
        aclOk++;
      } catch (e) {
        aclFail++;
        if (aclFail < 5) console.error("  acl fail:", Key, "-", e.message);
      }
    }
  }
  console.log(`  ACL: ${aclOk} ok, ${aclFail} failed`);

  // 5. Patch Firestore profiles
  console.log("patching Firestore profiles …");
  const db = getDb();
  let written = 0;
  for (const t of targets) {
    const urls = t.keys.map(imageUrlFor);
    try {
      await db.collection("members").doc(t.member.id).set({
        profile: {
          imageUrl: urls[0],
          images: urls,
        },
      }, { merge: true });
      written++;
    } catch (e) {
      console.error("  ", t.member.id, "write failed:", e.message);
    }
  }
  console.log(`  wrote ${written} member docs`);
  console.log("\n[done]");
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
