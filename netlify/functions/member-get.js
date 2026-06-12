import { getDb } from "./lib/db.js";
import { isAdminAuthorized } from "./lib/adminAuth.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const json = (statusCode, payload) => ({
  statusCode, headers: { ...corsHeaders, "Content-Type": "application/json" }, body: JSON.stringify(payload),
});

// Admin: fetch a single member's full profile by id, checking the real
// `members` collection first, then `sim_members`. Powers the "click a party →
// full profile" modal in the Convener. Strips phone + history.
export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders, body: "" };
  if (!isAdminAuthorized(event)) return json(401, { error: "Unauthorized" });

  const id = event.queryStringParameters?.id;
  if (!id) return json(400, { error: "id required" });

  try {
    const db = getDb();
    for (const collection of ["members", "sim_members"]) {
      const doc = await db.collection(collection).doc(id).get();
      if (!doc.exists) continue;
      const { history, ...rest } = doc.data();
      const { phone, ...profile } = rest.profile || {};
      return json(200, { id: doc.id, profile, source: rest.source ?? null, status: rest.status ?? null, collection });
    }
    return json(404, { error: "member not found" });
  } catch (err) {
    console.error("member-get error:", err);
    return json(500, { error: "lookup failed" });
  }
};
