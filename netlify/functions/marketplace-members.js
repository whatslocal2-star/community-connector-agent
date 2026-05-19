import { getDb } from "./lib/db.js";
import { Timestamp } from "firebase-admin/firestore";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function sanitize(member) {
  const { profile = {}, phone: topPhone, ...rest } = member;
  // Strip contact PII from public payloads. Business location data
  // (businessAddress / googleMapsUrl / lat / lng) is intentionally kept —
  // surfacing local businesses on a map is the whole product.
  const { phone, email, businessPhone, ...safeProfile } = profile;
  return { ...rest, profile: safeProfile };
}

// Server-side paginated browse. Netlify caps synchronous functions at 10s,
// so we keep Firestore work proportional to the page size:
// - orderBy lastActiveAt desc + startAfter cursor handles pagination
// - filters are applied in-memory on the fetched batch
//   (avoids needing per-filter composite indexes)
// - when filters are present we overfetch within reason
export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers: corsHeaders, body: "Method Not Allowed" };
  }

  try {
    const { type, city, category, subcategory, limit, cursor } = event.queryStringParameters || {};
    const max = Math.min(parseInt(limit, 10) || 50, 200);
    const hasFilter = Boolean(type || city || category || subcategory);
    const fetchLimit = hasFilter ? Math.min(max * 4, 200) : max;

    const db = getDb();
    let q = db.collection("members").orderBy("lastActiveAt", "desc");

    if (cursor) {
      const ms = parseInt(cursor, 10);
      // lastActiveAt is stored as a Firestore Timestamp (set via
      // serverTimestamp()), NOT an ISO string. startAfter must receive
      // the same type the orderBy field holds, otherwise the cursor
      // silently misses and the same page repeats forever.
      if (Number.isFinite(ms)) {
        q = q.startAfter(Timestamp.fromMillis(ms));
      }
    }

    const snap = await q.limit(fetchLimit).get();
    let members = snap.docs.map(d => {
      const { history, ...rest } = d.data();
      return { id: d.id, ...rest };
    });

    if (type) {
      const t = type.toLowerCase();
      members = members.filter(m => (m.profile?.memberType || "").toLowerCase() === t);
    }
    if (category) {
      const c = category.toLowerCase();
      members = members.filter(m => (m.profile?.category || "").toLowerCase() === c);
    }
    if (subcategory) {
      const s = subcategory.toLowerCase();
      members = members.filter(m => (m.profile?.subcategory || "").toLowerCase() === s);
    }
    if (city) {
      const c = city.toLowerCase();
      members = members.filter(m => (m.profile?.city || "").toLowerCase().includes(c));
    }

    const sliced = members.slice(0, max).map(sanitize);
    // Cursor for next page: smallest lastActiveAt we returned (epoch ms).
    // Null when fewer rows came back than the page asked for.
    const last = sliced[sliced.length - 1];
    const lastActiveMs = last?.lastActiveAt?._seconds != null
      ? last.lastActiveAt._seconds * 1000 + Math.floor((last.lastActiveAt._nanoseconds ?? 0) / 1e6)
      : null;
    const nextCursor = snap.size === fetchLimit && lastActiveMs ? String(lastActiveMs) : null;

    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ members: sliced, total: sliced.length, nextCursor }),
    };
  } catch (err) {
    console.error("marketplace-members error:", err?.message, err?.stack);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Failed to load members", detail: String(err?.message || err) }),
    };
  }
};
