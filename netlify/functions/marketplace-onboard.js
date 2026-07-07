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
    if (!profileUpdate || typeof profileUpdate !== "object" || !profileUpdate.name) {
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
