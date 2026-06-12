import { proposePairings, buildGroup, nextBestForRole, inventEvent } from "./lib/convener.js";
import { listCollabs, collabPairKeys } from "./lib/collabs.js";
import { loadFormats, loadFormat, parseLineup } from "./lib/matchFormats.js";
import { isAdminAuthorized } from "./lib/adminAuth.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (statusCode, payload) => ({
  statusCode,
  headers: { ...corsHeaders, "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

// Convener compute endpoint (admin). Generates proposals for review; never
// persists or sends. Modes:
//   { mode: "pairings", limit?, compose? }        → Type 1 intro drafts
//   { mode: "group", seedMemberId?, size? }       → Type 2 group draft
//   { mode: "invent-event", hint? }               → Type 3 event + role candidate lists
//   { mode: "next-best", needsText, roleType?, excludeIds? }  → replace-flow candidates
export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: corsHeaders, body: "Method Not Allowed" };
  if (!isAdminAuthorized(event)) return { statusCode: 401, headers: corsHeaders, body: "Unauthorized" };

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return json(400, { error: "Invalid JSON" }); }

  const mode = body.mode || "pairings";

  try {
    if (mode === "pairings") {
      // Don't resurface people already flagged or approved together.
      const existing = await listCollabs({ limit: 500 });
      const exclude = existing
        .filter(c => c.status !== "dismissed")
        .flatMap(collabPairKeys);
      const limit = Math.min(Math.max(Number(body.limit) || 12, 1), 25);
      const compose = Math.min(Math.max(Number(body.compose) || 4, 1), 10);
      const drafts = await proposePairings({ limit, compose, excludePairKeys: exclude });
      return json(200, { mode, count: drafts.length, drafts });
    }

    if (mode === "group") {
      const size = Math.min(Math.max(Number(body.size) || 3, 2), 5);
      const draft = await buildGroup({ seedMemberId: body.seedMemberId || null, size });
      if (!draft) return json(200, { mode, draft: null, note: "Not enough complementary members to form a group yet." });
      return json(200, { mode, draft });
    }

    if (mode === "invent-event") {
      const draft = await inventEvent({ hint: body.hint || null });
      if (!draft) return json(200, { mode, draft: null, note: "Couldn't invent an event from the current network yet." });
      return json(200, { mode, draft });
    }

    if (mode === "formats") {
      const formats = await loadFormats({ limit: 25 });
      return json(200, { mode, count: formats.length, formats });
    }

    if (mode === "from-format") {
      if (!body.signature) return json(400, { error: "signature required" });
      const fmt = await loadFormat(body.signature);
      const lineup = fmt?.typeLineup?.length ? fmt.typeLineup : parseLineup(body.signature);
      if (!lineup.length) return json(404, { error: "format not found" });
      const draft = await buildGroup({ lineup });
      if (!draft) return json(200, { mode, draft: null, note: "Couldn't assemble a fresh lineup for this format yet." });
      // Carry the worked title forward as a starting point.
      if (fmt?.exampleTitle && !draft.title) draft.title = fmt.exampleTitle;
      return json(200, { mode, draft });
    }

    if (mode === "next-best") {
      if (!body.needsText && !body.roleType) return json(400, { error: "needsText or roleType required" });
      const candidates = await nextBestForRole({
        needsText: body.needsText || "",
        roleType: body.roleType || null,
        excludeIds: Array.isArray(body.excludeIds) ? body.excludeIds : [],
        limit: Math.min(Math.max(Number(body.limit) || 8, 1), 20),
      });
      return json(200, { mode, count: candidates.length, candidates });
    }

    return json(400, { error: `unknown mode: ${mode}` });
  } catch (err) {
    console.error("convener error:", err);
    return json(500, { error: "Convener compute failed" });
  }
};
