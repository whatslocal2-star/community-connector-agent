import { searchMembers } from "./lib/search.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  try {
    let query, filters = {}, excludes = {}, limit;

    if (event.httpMethod === "GET") {
      const qs = event.queryStringParameters || {};
      query = qs.q;
      limit = qs.limit ? parseInt(qs.limit, 10) : undefined;
    } else if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      ({ query, filters = {}, excludes = {}, limit } = body);
    } else {
      return { statusCode: 405, headers: corsHeaders, body: "Method Not Allowed" };
    }

    const result = await searchMembers({
      query,
      filters,
      excludes,
      limit: Math.min(limit || 20, 100),
    });

    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(result),
    };
  } catch (err) {
    console.error("search error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Search failed" }),
    };
  }
};
