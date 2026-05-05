import { loadConversation } from "./lib/db.js";

export const handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const token = event.headers.authorization?.replace("Bearer ", "");
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  const memberId = event.queryStringParameters?.memberId;
  if (!memberId) {
    return { statusCode: 400, body: JSON.stringify({ error: "memberId required" }) };
  }

  try {
    const history = await loadConversation(memberId);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ history }),
    };
  } catch (err) {
    console.error("Conversation fetch error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: "Failed to load conversation" }) };
  }
};
