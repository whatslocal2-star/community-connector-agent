import { loadEventSuggestions } from "./lib/events.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers: corsHeaders, body: "Method Not Allowed" };
  }

  try {
    const { memberId, limit } = event.queryStringParameters || {};
    const max = Math.min(parseInt(limit, 10) || 20, 100);

    const events = await loadEventSuggestions({
      status: "approved",
      memberId: memberId || undefined,
      limit: max,
    });

    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ events }),
    };
  } catch (err) {
    console.error("marketplace-events error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Failed to load events" }),
    };
  }
};
