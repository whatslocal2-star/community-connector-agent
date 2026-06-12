import { createCollab, listCollabs, loadCollab, approveCollab, dismissCollab } from "./lib/collabs.js";
import { openRoomForCollab } from "./lib/collabRooms.js";
import { isAdminAuthorized } from "./lib/adminAuth.js";

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

// Convener collab store (admin). The review queue + draft lifecycle.
//   GET  ?status=&type=                          → list collabs (review queue)
//   POST { action: "save", draft, source? }      → persist a composed proposal
//   POST { action: "approve", id, parties?, ... } → freeze + seed learning loop
//   POST { action: "dismiss", id }               → drop from the queue
export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders, body: "" };
  if (!isAdminAuthorized(event)) return { statusCode: 401, headers: corsHeaders, body: "Unauthorized" };

  try {
    if (event.httpMethod === "GET") {
      const { status, type } = event.queryStringParameters || {};
      const collabs = await listCollabs({ status, type });
      return json(200, { count: collabs.length, collabs });
    }

    if (event.httpMethod === "POST") {
      let body;
      try { body = JSON.parse(event.body || "{}"); }
      catch { return json(400, { error: "Invalid JSON" }); }

      const action = body.action;

      if (action === "save") {
        const d = body.draft;
        if (!d?.type) return json(400, { error: "draft.type required" });
        const id = await createCollab({
          type: d.type,
          source: body.source || "manual",
          title: d.title ?? null,
          description: d.description ?? null,
          adminSummary: d.adminSummary ?? null,
          parties: d.parties ?? [],
          rolesNeeded: d.rolesNeeded ?? [],
          seedMemberId: d.seedMemberId ?? null,
          basis: d.basis ?? null,
          fit: d.fit ?? [],
          status: body.status || "flagged",
        });
        return json(200, { ok: true, id });
      }

      if (action === "approve") {
        if (!body.id) return json(400, { error: "id required" });
        const result = await approveCollab(body.id, {
          parties: body.parties,
          title: body.title,
          description: body.description,
          adminSummary: body.adminSummary,
        });
        if (!result) return json(404, { error: "collab not found" });
        return json(200, { ok: true, ...result });
      }

      if (action === "dismiss") {
        if (!body.id) return json(400, { error: "id required" });
        const result = await dismissCollab(body.id);
        return json(200, { ok: true, ...result });
      }

      if (action === "recur") {
        if (!body.id) return json(400, { error: "id required" });
        const src = await loadCollab(body.id);
        if (!src) return json(404, { error: "collab not found" });
        // Repeat with the same parties: a fresh flagged clone to re-approve.
        const parties = (src.parties || [])
          .filter(p => p.partyStatus !== "out")
          .map(p => ({ ...p, partyStatus: "proposed", response: null, invitedAt: null }));
        const id = await createCollab({
          type: src.type,
          source: "manual",
          title: src.title,
          description: src.description,
          adminSummary: src.adminSummary,
          parties,
          rolesNeeded: src.rolesNeeded || [],
          seedMemberId: src.seedMemberId ?? null,
          status: "flagged",
        });
        return json(200, { ok: true, id });
      }

      if (action === "open-room") {
        if (!body.id) return json(400, { error: "id required" });
        const collab = await loadCollab(body.id);
        if (!collab) return json(404, { error: "collab not found" });
        const result = await openRoomForCollab(collab);
        if (result.error) return json(409, { error: result.error });
        return json(200, { ok: true, ...result });
      }

      if (action === "get") {
        if (!body.id) return json(400, { error: "id required" });
        const collab = await loadCollab(body.id);
        if (!collab) return json(404, { error: "collab not found" });
        return json(200, { collab });
      }

      return json(400, { error: `unknown action: ${action}` });
    }

    return json(405, { error: "Method Not Allowed" });
  } catch (err) {
    console.error("convener-collabs error:", err);
    return json(500, { error: "Request failed" });
  }
};
