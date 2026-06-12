import { loadRoom, loadMessages, postMessage, listRoomsForMember, recordProceedVote, isParticipant } from "./lib/collabRooms.js";
import { loadMember } from "./lib/db.js";
import { isMarketplaceAuthorized } from "./lib/marketplaceAuth.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const json = (statusCode, payload) => ({
  statusCode,
  headers: { ...corsHeaders, "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

// Strip Firestore plumbing the marketplace doesn't need.
const shapeRoom = (r) => ({
  id: r.id,
  collabId: r.collabId,
  title: r.title,
  type: r.type,
  status: r.status,
  outcome: r.outcome ?? null,
  participants: r.participants || [],
  proceedVotes: r.proceedVotes || {},
});

// Marketplace-facing collab room API. Authenticated by the marketplace server
// (MARKETPLACE_API_KEY); every call asserts a member_id we verify is a room
// participant before returning or writing anything.
//   GET  ?memberId=<id>                        → that member's rooms
//   POST { action:"messages", roomId, memberId }      → room + messages
//   POST { action:"send", roomId, memberId, text }    → post a message
//   POST { action:"vote", roomId, memberId, vote }    → proceed/skip vote
export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders, body: "" };
  if (!isMarketplaceAuthorized(event)) return json(401, { error: "Unauthorized" });

  try {
    if (event.httpMethod === "GET") {
      const memberId = event.queryStringParameters?.memberId;
      if (!memberId) return json(400, { error: "memberId required" });
      const rooms = await listRoomsForMember(memberId);
      return json(200, { count: rooms.length, rooms: rooms.map(shapeRoom) });
    }

    if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return json(400, { error: "Invalid JSON" }); }

    const { action, roomId, memberId } = body;
    if (!roomId || !memberId) return json(400, { error: "roomId and memberId required" });

    const room = await loadRoom(roomId);
    if (!room) return json(404, { error: "room not found" });
    if (!isParticipant(room, memberId)) return json(403, { error: "not a participant" });

    if (action === "messages") {
      const messages = await loadMessages(roomId);
      return json(200, { room: shapeRoom(room), messages });
    }

    if (action === "send") {
      const text = (body.text || "").trim();
      if (!text) return json(400, { error: "text required" });
      if (room.status !== "open") return json(409, { error: "room is closed" });
      const member = await loadMember(memberId);
      const senderName = member?.profile?.name
        || room.participants.find(p => p.memberId === memberId)?.memberName
        || null;
      const id = await postMessage(roomId, { senderId: memberId, senderName, text: text.slice(0, 2000) });
      return json(200, { ok: true, id });
    }

    if (action === "vote") {
      if (!["proceed", "skip"].includes(body.vote)) return json(400, { error: "vote must be 'proceed' or 'skip'" });
      const result = await recordProceedVote(roomId, memberId, body.vote);
      return json(200, { ok: true, ...result });
    }

    return json(400, { error: `unknown action: ${action}` });
  } catch (err) {
    console.error("room error:", err);
    return json(500, { error: "Request failed" });
  }
};
