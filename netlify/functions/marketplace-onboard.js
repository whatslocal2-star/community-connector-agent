import OpenAI from "openai";
import crypto from "crypto";
import { buildSystemPrompt } from "./lib/systemPrompt.js";
import { parseCompletion } from "./lib/profileTool.js";
import { saveMember, loadMember } from "./lib/db.js";
import { upsertMemberVector } from "./lib/vectorSearch.js";
import { parsePriceRange, normalizePricePerProduct } from "./lib/priceParse.js";
import { isAdminAuthorized, unauthorized } from "./lib/adminAuth.js";
import { enqueuePostSave } from "./lib/triggerPostSave.js";

// POST — onboard a NEW member from a full conversation (the marketplace's in-app
// booth chat). Runs the SAME profiling brain as chat.js/sms.js over the whole
// transcript in one shot, then saves + embeds. Admin-token authed.
// Body: { messages: [{role, content}], source? }
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MAX_HISTORY = 24;

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
  if (!isAdminAuthorized(event)) return unauthorized();

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  const raw = Array.isArray(body.messages) ? body.messages.slice(-MAX_HISTORY) : [];
  const convo = raw
    .filter((m) => m && m.content)
    .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content) }));
  if (!convo.length) return { statusCode: 400, body: JSON.stringify({ error: "messages required" }) };

  const source = body.source || "marketplace_onboard";

  // Optional: enrich an EXISTING member in place (the marketplace /join voice or
  // text interview — the member was already created + verified/claimed there).
  // Without this the function always mints a new id, which would duplicate.
  const existingId =
    typeof body.memberId === "string" && body.memberId.trim() ? body.memberId.trim() : null;

  try {
    // Same model + onboarding system prompt + JSON mode as chat.js, but over the
    // entire conversation at once (no prior profile = onboarding mode).
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 512,
      messages: [{ role: "system", content: buildSystemPrompt(undefined, { sms: false }) }, ...convo],
      response_format: { type: "json_object" },
    });
    const { profileUpdate } = parseCompletion(completion);
    // For a NEW member we need at least a name; for an existing member the name
    // is already set/verified, so any captured detail is enough.
    if (!profileUpdate || typeof profileUpdate !== "object" || (!existingId && !profileUpdate.name)) {
      return { statusCode: 422, body: JSON.stringify({ error: "Could not capture a business name from the chat" }) };
    }

    // Same price normalization chat.js applies before saving.
    const normalized = { ...profileUpdate };
    if (profileUpdate.priceRange && profileUpdate.priceMin == null && profileUpdate.priceMax == null) {
      const parsed = parsePriceRange(profileUpdate.priceRange);
      if (parsed) Object.assign(normalized, parsed);
    }
    if (profileUpdate.pricePerProduct) {
      normalized.pricePerProduct = normalizePricePerProduct(profileUpdate.pricePerProduct);
    }

    // ── Enrich an EXISTING member (marketplace /join interview) ──────────────
    if (existingId) {
      // Never let the interview overwrite the identity/verification anchors set
      // during /join (Google listing + ownership claim). It only enriches the
      // descriptive fields; name, location, contact + claim status are the
      // authoritative anchors and win.
      const PROTECTED = [
        "name", "memberType", "status", "claimedBy",
        "phone", "businessPhone", "trustedPhone", "ownerPhone",
        "googleMapsUrl", "latitude", "longitude", "city",
      ];
      for (const k of PROTECTED) delete normalized[k];

      // No status in meta → we never downgrade a claimed member to unclaimed.
      await saveMember(existingId, { profileUpdate: { ...normalized }, meta: { source } });
      await enqueuePostSave(existingId, { ...normalized }, source);

      const member = await loadMember(existingId);
      if (member?.profile && Object.keys(member.profile).length) {
        try {
          await upsertMemberVector(existingId, member.profile);
        } catch (e) {
          console.error("onboard(update) embed error:", e?.message || e);
        }
      }

      const { profile = {}, phone: _tp, ...rest } = member || {};
      const { phone, email, businessPhone, ...safeProfile } = profile;
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: existingId, member: { ...rest, profile: safeProfile } }),
      };
    }

    // ── Create a NEW member (booth QR onboarding) ────────────────────────────
    const status = "unclaimed";
    const id = crypto.randomUUID();
    await saveMember(id, { profileUpdate: { ...normalized, status }, meta: { source, status } });

    // Enrich (website / Google Places / IG) + cross-ref, like SMS/web onboarding.
    await enqueuePostSave(id, { ...normalized, status }, source);

    const member = await loadMember(id);
    if (member?.profile && Object.keys(member.profile).length) {
      try {
        await upsertMemberVector(id, member.profile);
      } catch (e) {
        console.error("onboard embed error:", e?.message || e);
      }
    }

    const { profile = {}, phone: _topPhone, ...rest } = member || {};
    const { phone, email, businessPhone, ...safeProfile } = profile;
    return {
      statusCode: 201,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, member: { ...rest, profile: safeProfile } }),
    };
  } catch (err) {
    console.error("marketplace-onboard error:", err?.message || err);
    return { statusCode: 500, body: JSON.stringify({ error: "Failed to onboard" }) };
  }
};
