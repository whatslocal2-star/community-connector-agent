import { loadAllMembers } from "./lib/db.js";
import { isAdminAuthorized, unauthorized } from "./lib/adminAuth.js";

export const handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  if (!isAdminAuthorized(event)) return unauthorized();

  try {
    const members = await loadAllMembers();
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ members }),
    };
  } catch (err) {
    console.error("Admin fetch error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: "Failed to load members" }) };
  }
};
