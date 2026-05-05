import { loadMember, saveMember } from "./lib/db.js";
import { enrichProfile } from "./lib/enrich.js";
import { upsertMemberVector } from "./lib/vectorSearch.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders, body: "Method Not Allowed" };
  }

  const token = event.headers.authorization?.replace("Bearer ", "");
  if (token !== process.env.ADMIN_TOKEN) {
    return { statusCode: 401, headers: corsHeaders, body: "Unauthorized" };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const { sessionId } = body;
  if (!sessionId) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "sessionId required" }) };
  }

  try {
    const member = await loadMember(sessionId);
    if (!member?.profile) {
      return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: "Member not found" }) };
    }

    const enriched = await enrichProfile(member.profile);
    if (!enriched) {
      return {
        statusCode: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "no_data", message: "No enrichable sources found" }),
      };
    }

    const safeFields = {};
    for (const [k, v] of Object.entries(enriched)) {
      if (v !== undefined && v !== null && !member.profile[k]) {
        safeFields[k] = v;
      }
    }

    if (Object.keys(safeFields).length) {
      await saveMember(sessionId, { profileUpdate: { ...safeFields, enrichedAt: new Date().toISOString() } });
      const updated = await loadMember(sessionId);
      if (updated?.profile) {
        await upsertMemberVector(sessionId, updated.profile);
      }
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "enriched", fieldsAdded: Object.keys(safeFields) }),
    };
  } catch (err) {
    console.error("Enrich error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Enrichment failed" }),
    };
  }
};
