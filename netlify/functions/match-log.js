import { createMatchLog, loadMatchLogs } from "./lib/matchLog.js";
import { loadMember } from "./lib/db.js";
import { isAdminAuthorized } from "./lib/adminAuth.js";

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
      const { memberId, matchedMemberId, reason, channel } = JSON.parse(event.body);
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
