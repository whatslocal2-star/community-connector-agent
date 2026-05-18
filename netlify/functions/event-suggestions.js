import { loadEventSuggestions, updateEventSuggestionStatus, REJECTION_REASONS } from "./lib/events.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
};

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  const token = event.headers.authorization?.replace("Bearer ", "");
  if (token !== process.env.ADMIN_TOKEN) {
    return { statusCode: 401, headers: corsHeaders, body: "Unauthorized" };
  }

  try {
    if (event.httpMethod === "GET") {
      const { status, memberId } = event.queryStringParameters || {};
      const suggestions = await loadEventSuggestions({ status, memberId });
      return {
        statusCode: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(suggestions),
      };
    }

    if (event.httpMethod === "PUT") {
      const body = JSON.parse(event.body);
      const { id, status, rejectionReason, rejectionNote } = body;
      if (!id || !["approved", "rejected"].includes(status)) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({ error: "id and status (approved|rejected) required" }),
        };
      }
      if (status === "rejected" && rejectionReason && !REJECTION_REASONS.includes(rejectionReason)) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({ error: `rejectionReason must be one of ${REJECTION_REASONS.join(", ")}` }),
        };
      }
      await updateEventSuggestionStatus(id, status, { rejectionReason, rejectionNote });
      return {
        statusCode: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ ok: true }),
      };
    }

    return { statusCode: 405, headers: corsHeaders, body: "Method Not Allowed" };
  } catch (err) {
    console.error("Event suggestions error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Failed to process request" }),
    };
  }
};
