import { createMatchLog, loadMatchLogs, recordOutcome } from "./lib/matchLog.js";
import { loadMember } from "./lib/db.js";
import { isAdminAuthorized } from "./lib/adminAuth.js";

// Build a structured outcome from a convener's one-tap verdict, shaped like
// the GPT-extracted outcomes the followup loop produces — so in-context
// learning and the future re-ranker consume convener-labeled and
// member-replied outcomes identically.
function convenerOutcome(verdict, note) {
  const worked = verdict === "worked";
  return {
    attended: worked,
    sentiment: worked ? "positive" : "negative",
    reasons_positive: [],
    reasons_negative: [],
    would_repeat: worked,
    implicit_profile_updates: {},
    summary: note || (worked ? "Convener marked this intro as worked." : "Convener marked this intro as didn't pan out."),
    recordedBy: "convener",
  };
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  if (!isAdminAuthorized(event)) {
    return { statusCode: 401, headers: corsHeaders, body: "Unauthorized" };
  }

  try {
    if (event.httpMethod === "GET") {
      const { memberId, status } = event.queryStringParameters || {};
      const logs = await loadMatchLogs({ memberId, status });
      return {
        statusCode: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(logs),
      };
    }

    if (event.httpMethod === "POST") {
      const payload = JSON.parse(event.body);

      // Convener outcome-logging: record how an intro went, directly on an
      // existing matchLog. Marks it completed so it becomes a labeled
      // training example without waiting for the 48h followup loop.
      if (payload.matchLogId && payload.verdict) {
        if (!["worked", "didnt"].includes(payload.verdict)) {
          return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "verdict must be 'worked' or 'didnt'" }) };
        }
        const outcome = convenerOutcome(payload.verdict, payload.note);
        await recordOutcome(payload.matchLogId, { raw: payload.note ?? null, outcome });
        return {
          statusCode: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ ok: true, id: payload.matchLogId, outcome }),
        };
      }

      const { memberId, matchedMemberId, reason, channel } = payload;
      if (!memberId || !matchedMemberId) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "memberId and matchedMemberId required" }) };
      }
      const [member, matched] = await Promise.all([loadMember(memberId), loadMember(matchedMemberId)]);
      const id = await createMatchLog({
        memberId,
        memberName: member?.profile?.name ?? null,
        matchedMemberId,
        matchedMemberName: matched?.profile?.name ?? null,
        reason,
        channel: channel ?? (member?.phone ? "sms" : "web"),
      });
      return {
        statusCode: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ ok: true, id }),
      };
    }

    return { statusCode: 405, headers: corsHeaders, body: "Method Not Allowed" };
  } catch (err) {
    console.error("match-log error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Failed to process request" }),
    };
  }
};
