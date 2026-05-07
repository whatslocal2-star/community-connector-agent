import { loadAllMembers } from "./lib/db.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function sanitize(member) {
  const { profile = {}, ...rest } = member;
  const { phone, ...safeProfile } = profile;
  return { ...rest, profile: safeProfile };
}

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

    // Pull a generous batch then filter in-memory; loadAllMembers already strips history
    let members = await loadAllMembers(500);

    if (type) {
      members = members.filter(m => (m.profile?.memberType || "").toLowerCase() === type.toLowerCase());
    }
    if (city) {
      const c = city.toLowerCase();
      members = members.filter(m => (m.profile?.city || "").toLowerCase().includes(c));
    }
    if (category) {
      members = members.filter(m => (m.profile?.category || "").toLowerCase() === category.toLowerCase());
    }
    if (subcategory) {
      members = members.filter(m => (m.profile?.subcategory || "").toLowerCase() === subcategory.toLowerCase());
    }
    if (cursor) {
      // cursor is a millisecond timestamp; return only items older than cursor
      const cursorMs = parseInt(cursor, 10);
      if (!Number.isNaN(cursorMs)) {
        members = members.filter(m => {
          const ts = m.lastActiveAt?._seconds ? m.lastActiveAt._seconds * 1000 : 0;
          return ts < cursorMs;
        });
      }
    }

    const total = members.length;
    const sliced = members.slice(0, max).map(sanitize);

    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ members: sliced, total }),
    };
  } catch (err) {
    console.error("marketplace-members error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Failed to load members" }),
    };
  }
};
