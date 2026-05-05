import { loadSubscriptions, loadAllActiveSubscriptions } from "./lib/db.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers: corsHeaders, body: "Method Not Allowed" };
  }

  const token = event.headers.authorization?.replace("Bearer ", "");
  if (token !== process.env.ADMIN_TOKEN) {
    return { statusCode: 401, headers: corsHeaders, body: "Unauthorized" };
  }

  try {
    const memberId = event.queryStringParameters?.memberId;

    const data = memberId
      ? await loadSubscriptions(memberId)
      : await loadAllActiveSubscriptions();

    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(data),
    };
  } catch (err) {
    console.error("Subscriptions error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Failed to load subscriptions" }),
    };
  }
};
