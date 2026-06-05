import { isAdminAuthorized } from "./lib/adminAuth.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Outbound transactional SMS via Telnyx. Used by the marketplace's Uber Direct
// webhook to text buyers their delivery / tracking updates.
//
// POST { to, message }   (Bearer ADMIN_TOKEN)
//   → sends `message` to `to` from TELNYX_FROM_NUMBER
//   → returns { sent: true }
async function sendSms(to, text) {
  const from = process.env.TELNYX_FROM_NUMBER;
  if (!from) throw new Error("TELNYX_FROM_NUMBER not configured");
  const res = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, text }),
  });
  if (!res.ok) {
    throw new Error(`Telnyx send failed: ${res.status} ${await res.text()}`);
  }
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }
  if (!isAdminAuthorized(event)) {
    return { statusCode: 401, headers: corsHeaders, body: "Unauthorized" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders, body: "Method Not Allowed" };
  }

  try {
    const { to, message } = JSON.parse(event.body || "{}");
    if (!to || !message) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: "to and message required" }),
      };
    }
    await sendSms(to, message);
    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ sent: true }),
    };
  } catch (err) {
    console.error("sms-send error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Failed to send SMS" }),
    };
  }
};
