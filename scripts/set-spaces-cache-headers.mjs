// One-shot: set Cache-Control on every object under businesses/* so browsers
// (and any CDN later) cache aggressively. URLs are content-addressed via the
// filename → immutable is safe.
//
// Run via:
//   netlify dev:exec -- node scripts/set-spaces-cache-headers.mjs --dry
//   netlify dev:exec -- node scripts/set-spaces-cache-headers.mjs

import fs from "node:fs";
import path from "node:path";
import { S3Client, ListObjectsV2Command, CopyObjectCommand } from "@aws-sdk/client-s3";

const DRY = process.argv.includes("--dry");

function loadSpacesEnv() {
  if (process.env.AWS_ACCESS_KEY_ID && process.env.SPACES_BUCKET) return;
  const f = path.join(process.env.HOME, "Desktop/dev/archive/prolocaliq/.env");
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^(SPACES_BUCKET|AWS_ENDPOINT|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
}
loadSpacesEnv();

const endpoint = process.env.AWS_ENDPOINT;
const bucket = process.env.SPACES_BUCKET;
const region = endpoint?.match(/\/\/([^.]+)\./)?.[1] || "nyc3";
const s3 = new S3Client({
  endpoint, region,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const CACHE_HEADER = "public, max-age=31536000, immutable";

async function listAllUnderPrefix(prefix) {
  let keys = [], token;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 }));
    keys = keys.concat((r.Contents || []).map(o => o.Key));
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function main() {
  console.log(`[cache-headers] ${DRY ? "DRY" : "LIVE"} · bucket=${bucket}`);
  const keys = (await listAllUnderPrefix("businesses/")).filter(k => /\.(jpe?g|png|webp|gif)$/i.test(k));
  console.log(`  ${keys.length} image objects under businesses/`);
  if (DRY) {
    console.log(`  would set Cache-Control: ${CACHE_HEADER} on all`);
    return;
  }

  let ok = 0, fail = 0;
  for (const Key of keys) {
    try {
      // S3 CopyObject with same source/destination + MetadataDirective:REPLACE
      // is the canonical way to update object metadata in place.
      await s3.send(new CopyObjectCommand({
        Bucket: bucket,
        Key,
        CopySource: `/${bucket}/${encodeURIComponent(Key)}`,
        MetadataDirective: "REPLACE",
        CacheControl: CACHE_HEADER,
        ContentType: Key.toLowerCase().endsWith(".png") ? "image/png"
          : Key.toLowerCase().endsWith(".webp") ? "image/webp"
          : Key.toLowerCase().endsWith(".gif") ? "image/gif"
          : "image/jpeg",
        ACL: "public-read",
      }));
      ok++;
      if (ok % 100 === 0) console.log(`  ${ok}/${keys.length}`);
    } catch (e) {
      fail++;
      if (fail < 5) console.error("  fail:", Key, "-", e.message);
    }
  }
  console.log(`[done] ok=${ok} fail=${fail}`);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
