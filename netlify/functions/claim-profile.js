import { getDb } from "./lib/db.js";
import { FieldValue } from "firebase-admin/firestore";
import { isAdminAuthorized } from "./lib/adminAuth.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Admin-stub claim flow. Real claim verification (email/phone) comes
// later — for now this just flips an unclaimed harvested profile to
// "claimed" and merges any provided fields. Useful for backfills and
// manual claims from the dashboard.
//
// POST { unclaimedId, claimedBy?, fields? }
//   unclaimedId — Firestore doc id of the harvested member (e.g. gp_ChIJ...)
//   claimedBy   — optional sessionId of the claiming member (for linking)
//   fields      — optional profile fields to merge on claim
export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders, body: "Method Not Allowed" };
  }

  if (!isAdminAuthorized(event)) {
    return { statusCode: 401, headers: corsHeaders, body: "Unauthorized" };
  }

  try {
    const { unclaimedId, claimedBy, fields } = JSON.parse(event.body);
    if (!unclaimedId) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "unclaimedId required" }) };
    }

    const db = getDb();
    const ref = db.collection("members").doc(unclaimedId);
    const snap = await ref.get();
    if (!snap.exists) {
      return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: "Not found" }) };
    }

    const update = {
      status: "claimed",
      claimedAt: FieldValue.serverTimestamp(),
      claimedBy: claimedBy ?? null,
    };
    if (fields && typeof fields === "object") {
      for (const [k, v] of Object.entries(fields)) {
        if (v != null) update[`profile.${k}`] = v;
      }
    }
    await ref.update(update);

    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, id: unclaimedId }),
    };
  } catch (err) {
    console.error("claim-profile error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Failed to claim" }),
    };
  }
};
