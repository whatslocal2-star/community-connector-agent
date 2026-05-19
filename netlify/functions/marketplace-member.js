import { loadMember } from "./lib/db.js";

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

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers: corsHeaders, body: "Method Not Allowed" };
  }

  const { id } = event.queryStringParameters || {};
  if (!id) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: "id query param required" }),
    };
  }

  try {
    const member = await loadMember(id);
    if (!member) {
      return {
        statusCode: 404,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Member not found" }),
      };
    }
    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ member: sanitize(member) }),
    };
  } catch (err) {
    console.error("marketplace-member error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Failed to load member" }),
    };
  }
};
