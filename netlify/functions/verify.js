import { loadMember, saveMember } from "./lib/db.js";
import { verifyBusinessOwnership, availableVerificationMethods, VERIFICATION_METHODS } from "./lib/verify.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// POST { memberId, method, value }
//   → runs ownership verification, escalates to Gemini if structured check fails
//   → on success saves profile.ownershipVerification = { verified, method, evidence, verifiedAt }
//   → returns { verified, method, evidence }
//
// GET ?memberId=...
//   → returns { availableMethods, current } where current is the saved verification state
//
// Auth: requires ADMIN_TOKEN (used by chat agent + marketplace vendor portal).
export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  const token = event.headers.authorization?.replace("Bearer ", "");
  if (token !== process.env.ADMIN_TOKEN) {
    return { statusCode: 401, headers: corsHeaders, body: "Unauthorized" };
  }

  try {
    if (event.httpMethod === "GET") {
      const { memberId } = event.queryStringParameters || {};
      if (!memberId) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "memberId required" }) };
      }
      const member = await loadMember(memberId);
      if (!member) {
        return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: "Not found" }) };
      }
      return {
        statusCode: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          availableMethods: availableVerificationMethods(member.profile || {}),
          current: member.profile?.ownershipVerification ?? null,
        }),
      };
    }

    if (event.httpMethod === "POST") {
      const { memberId, method, value } = JSON.parse(event.body);
      if (!memberId || !method || !value) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "memberId, method, value required" }) };
      }
      if (!VERIFICATION_METHODS.includes(method)) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: `method must be one of ${VERIFICATION_METHODS.join(", ")}` }) };
      }
      const member = await loadMember(memberId);
      if (!member) {
        return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: "Not found" }) };
      }
      const profile = member.profile || {};

      const available = availableVerificationMethods(profile);
      if (!available.includes(method)) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "method not available for this profile" }) };
      }

      let result = await verifyBusinessOwnership(method, value, profile);

      // Escalate to Gemini if structured check failed.
      if (!result.verified && method !== "gemini") {
        const escalated = await verifyBusinessOwnership("gemini", value, profile);
        if (escalated.verified) result = escalated;
      }

      if (result.verified) {
        await saveMember(memberId, {
          profileUpdate: {
            ownershipVerification: {
              verified: true,
              method: result.method,
              evidence: result.evidence,
              verifiedAt: new Date().toISOString(),
              verifiedValue: value,
            },
          },
        });
      }

      return {
        statusCode: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(result),
      };
    }

    return { statusCode: 405, headers: corsHeaders, body: "Method Not Allowed" };
  } catch (err) {
    console.error("verify error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Verification failed" }),
    };
  }
};
