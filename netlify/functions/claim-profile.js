import { getDb } from "./lib/db.js";
import { FieldValue } from "firebase-admin/firestore";
import { isAdminAuthorized } from "./lib/adminAuth.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Flip an unclaimed harvested profile to "claimed".
//
// Trust gate: a profile can only be claimed once ownership has actually been
// proven — i.e. `/verify` has written `profile.ownershipVerification.verified`.
// The marketplace claim BFF calls /verify first (which writes that field) and
// then this endpoint, so the normal flow passes the gate. Admin backfills /
// manual claims bypass it with `force: true`.
//
// This used to be a pure stub that flipped status with no verification, which
// meant anyone holding the admin token could claim any business unverified.
//
// POST { unclaimedId, claimedBy?, fields?, force? }
//   unclaimedId — Firestore doc id of the harvested member (e.g. gp_ChIJ...)
//   claimedBy   — optional sessionId / external user id of the claimer (for linking)
//   fields      — optional profile fields to merge on claim
//   force       — admin override: claim without an ownershipVerification gate
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
    const { unclaimedId, claimedBy, fields, force } = JSON.parse(event.body);
    if (!unclaimedId) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "unclaimedId required" }) };
    }

    const db = getDb();
    const ref = db.collection("members").doc(unclaimedId);
    const snap = await ref.get();
    if (!snap.exists) {
      return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: "Not found" }) };
    }

    const data = snap.data();

    // Idempotency: already-claimed profiles aren't re-claimed silently.
    if (data.status === "claimed") {
      return {
        statusCode: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Profile already claimed", claimedBy: data.claimedBy ?? null }),
      };
    }

    // Trust gate: require proven ownership unless an admin forces it.
    const verification = data.profile?.ownershipVerification;
    if (!force && !verification?.verified) {
      return {
        statusCode: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Ownership not verified. Run /verify (or pass force:true as admin) before claiming.",
        }),
      };
    }

    const update = {
      status: "claimed",
      claimedAt: FieldValue.serverTimestamp(),
      claimedBy: claimedBy ?? null,
      claimMethod: force ? "admin_force" : (verification?.method ?? "verified"),
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
      body: JSON.stringify({ ok: true, id: unclaimedId, claimMethod: update.claimMethod }),
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
