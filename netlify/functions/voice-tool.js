import { loadMember, saveMember, findMemberByTrustedPhone } from "./lib/db.js";
import { upsertMemberVector } from "./lib/vectorSearch.js";
import { parsePriceRange, normalizePricePerProduct } from "./lib/priceParse.js";
import { shouldRecommend, makeFirstRecommendations } from "./lib/recommend.js";
import { enqueuePostSave } from "./lib/triggerPostSave.js";
import { initObservability, captureError, trackEvent, flushObservability } from "./lib/observability.js";

initObservability({ context: "voice-tool" });

// Webhook the Telnyx Voice AI Assistant calls (as a "save_profile" tool) so a
// phone call runs the SAME onboarding data capture as web/SMS: identical flat
// profile schema, same Firestore member (keyed by caller phone), same Pinecone
// embeddings, and the same first-recommendations pass at wrap-up.

// Member key is the caller's phone in +E164 — matches how sms.js keys members,
// so a caller who also texts is one unified profile.
function normalizePhone(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/[^\d+]/g, "");
  if (d.startsWith("+")) return d;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return `+${d}`;
}

// Same normalization sms.js applies before saving profileUpdate.
function normalizeUpdate(profileUpdate) {
  if (!profileUpdate || typeof profileUpdate !== "object") return profileUpdate;
  const out = { ...profileUpdate };
  if (profileUpdate.priceRange && profileUpdate.priceMin == null && profileUpdate.priceMax == null) {
    const parsed = parsePriceRange(profileUpdate.priceRange);
    if (parsed) Object.assign(out, parsed);
  }
  if (profileUpdate.pricePerProduct) {
    out.pricePerProduct = normalizePricePerProduct(profileUpdate.pricePerProduct);
  }
  return out;
}

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  // Shared-secret auth — configured on the Telnyx assistant tool.
  const secret = process.env.VOICE_TOOL_SECRET;
  const provided =
    event.headers?.["x-voice-tool-secret"] ||
    (event.headers?.["authorization"] || "").replace(/^Bearer\s+/i, "");
  if (secret && provided !== secret) {
    return { statusCode: 401, body: JSON.stringify({ error: "unauthorized" }) };
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { body = {}; }

  // Be tolerant of Telnyx's tool-call payload shape.
  const args = body.arguments || body.data?.arguments || body.parameters || body;
  const phone = normalizePhone(
    args.caller_phone || body.caller_phone || body.from || body.telnyx_end_user_target
  );
  const action = args.action || body.action || "save";

  if (!phone) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: "no caller phone" }) };
  }

  // profileUpdate may arrive as an object or a JSON string (same fields as web/SMS).
  let profileUpdate = args.profile ?? args.profile_json ?? args.updates ?? {};
  if (typeof profileUpdate === "string") {
    try { profileUpdate = JSON.parse(profileUpdate); } catch { profileUpdate = {}; }
  }

  try {
    // Possession gate: if this caller's number is the trusted onboarding number
    // an admin set on a pre-created profile (or one already linked to it), route
    // this call to THAT profile instead of a new caller-keyed record. Because
    // only this number resolves to that profile, no other caller can onboard or
    // claim it — the gate is by construction.
    const linked = await findMemberByTrustedPhone(phone);
    const targetId = linked?.id || phone;
    const firstLink = !!linked && linked.profile?.ownerPhone !== phone;

    const normalized = normalizeUpdate(profileUpdate);
    const saveUpdate =
      normalized && typeof normalized === "object" ? { ...normalized } : {};
    if (firstLink) {
      // First call from the trusted number → mark it owned + possession-verified.
      saveUpdate.ownerPhone = phone;
      saveUpdate.status = "claimed";
      saveUpdate.ownershipVerification = {
        verified: true,
        method: "inbound_possession",
        verifiedValue: phone,
        verifiedAt: new Date().toISOString(),
      };
    }
    if (Object.keys(saveUpdate).length) {
      await saveMember(targetId, { profileUpdate: saveUpdate, meta: { phone, source: "voice" } });
      // Enrichment + cross-ref (website / Google Places / IG) on the profile.
      await enqueuePostSave(targetId, saveUpdate, "voice");
    }

    const member = await loadMember(targetId);
    let recommendations = null;

    if (member?.profile) {
      try { await upsertMemberVector(targetId, member.profile); }
      catch (err) { console.error("voice embed error:", err); }

      // At wrap-up, fire the same first-recommendations pass web/SMS use.
      if (action === "finish" && shouldRecommend(member.profile) && !member.profile.firstRecsMadeAt) {
        trackEvent(targetId, "profile_completed", { channel: "voice", memberType: member.profile.memberType });
        try {
          const recs = await makeFirstRecommendations(targetId, member.profile, { channel: "voice" });
          if (recs?.paragraph) {
            recommendations = recs.paragraph;
            await saveMember(targetId, { profileUpdate: { firstRecsMadeAt: new Date().toISOString() } });
            trackEvent(targetId, "first_recs_sent", { channel: "voice", recCount: recs.logs?.length ?? null });
          }
        } catch (err) { captureError(err, { fn: "voice-tool", step: "recs", phone }); }
      }
    }

    await flushObservability();
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, saved: true, recommendations }),
    };
  } catch (err) {
    captureError(err, { fn: "voice-tool", phone });
    await flushObservability();
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: "save failed" }) };
  }
};
