import { loadAllMembers } from "./lib/db.js";
import { findSimilarMembers } from "./lib/vectorSearch.js";

export const handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const auth = event.headers.authorization || "";
  if (auth !== `Bearer ${process.env.ADMIN_TOKEN}`) {
    return { statusCode: 401, body: "Unauthorized" };
  }

  const { memberId, topK = "5" } = event.queryStringParameters || {};
  if (!memberId) {
    return { statusCode: 400, body: JSON.stringify({ error: "memberId required" }) };
  }

  try {
    const similar = await findSimilarMembers(memberId, parseInt(topK, 10));
    const allMembers = await loadAllMembers(500);
    const memberMap = Object.fromEntries(allMembers.map(m => [m.id, m]));

    const matches = similar
      .map(s => ({ ...memberMap[s.id], similarityScore: s.score }))
      .filter(m => m.id);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matches }),
    };
  } catch (err) {
    console.error("Matches error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to find matches" }),
    };
  }
};
