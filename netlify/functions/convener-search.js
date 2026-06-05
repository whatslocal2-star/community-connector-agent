import { loadMember } from "./lib/db.js";
import { findComplementaryMatches, findCollaboratorsForObjective } from "./lib/recommend.js";
import { isAdminAuthorized } from "./lib/adminAuth.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DIRECTION_LABEL = {
  they_offer_what_you_need: "offers what's needed",
  they_need_what_you_offer: "needs what this offers",
};

// Trim a hydrated complementary match down to what the admin UI needs to
// display + log an intro. Never leaks phone (already stripped upstream).
function shape(c) {
  const p = c.profile || {};
  return {
    id: c.id,
    score: Number(c.score?.toFixed?.(3) ?? c.score ?? 0),
    fit: (c.directions || []).map(d => DIRECTION_LABEL[d] || d),
    name: p.name || null,
    memberType: p.memberType || null,
    category: p.businessCategory || p.category || null,
    neighborhood: p.neighborhood || null,
    city: p.city || null,
    offers: p.offers || null,
    needs: p.needs || null,
    description: p.businessDescription || p.approvedBlurb || null,
    status: c.profile?.status || null, // unclaimed harvested profiles flagged
  };
}

// Admin convener tool. Two modes:
//   POST { objective: "event series about places of the world", limit? }
//     → members whose offers match what the objective needs.
//   POST { memberId: "<id>", limit? }
//     → complementary matches for an existing member (their needs↔offers).
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

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const limit = Math.min(Math.max(Number(body.limit) || 10, 1), 25);

  try {
    let mode, query, candidates;

    if (body.memberId) {
      const member = await loadMember(body.memberId);
      if (!member?.profile) {
        return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: "member not found" }) };
      }
      mode = "member";
      query = member.profile.name || body.memberId;
      candidates = await findComplementaryMatches(body.memberId, member.profile, { limit });
    } else if (body.objective && body.objective.trim()) {
      mode = "objective";
      query = body.objective.trim();
      candidates = await findCollaboratorsForObjective(query, { limit, excludeIds: body.excludeIds || [] });
    } else {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "Provide either objective or memberId" }) };
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ mode, query, count: candidates.length, candidates: candidates.map(shape) }),
    };
  } catch (err) {
    console.error("convener-search error:", err);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: "Search failed" }) };
  }
};
