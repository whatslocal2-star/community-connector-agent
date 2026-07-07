import crypto from "crypto";
import { saveMember, loadMember } from "./lib/db.js";
import { isAdminAuthorized, unauthorized } from "./lib/adminAuth.js";
import { upsertMemberVector } from "./lib/vectorSearch.js";
import { enqueuePostSave } from "./lib/triggerPostSave.js";

// POST — create a new member from the marketplace app (manual interview or QR
// self-onboarding). Admin-token authed. Body:
//   { id?, profileUpdate: { memberType, name, ... }, source? }
// Returns the created member in the same (sanitized) shape as marketplace-member.
export const handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
  if (!isAdminAuthorized(event)) return unauthorized();

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  const profileUpdate = body.profileUpdate;
  if (!profileUpdate || typeof profileUpdate !== "object" || !profileUpdate.name) {
    return { statusCode: 400, body: JSON.stringify({ error: "profileUpdate with a name is required" }) };
  }

  const id = body.id || crypto.randomUUID();
  const source = body.source || "marketplace";
  // New self-onboarded businesses start unclaimed until the owner verifies.
  const status = profileUpdate.status || "unclaimed";

  try {
    await saveMember(id, { profileUpdate: { ...profileUpdate, status }, meta: { source, status } });

    // Enrich from their website / Google Places / IG (fills empty fields only)
    // + run the channel cross-reference check — same background pipeline as SMS
    // and web onboarding, which admin-created profiles previously skipped.
    await enqueuePostSave(id, { ...profileUpdate, status }, source);

    const member = await loadMember(id);
    if (!member) return { statusCode: 500, body: JSON.stringify({ error: "Failed to load created member" }) };

    // Embedding is optional — gracefully no-ops if PINECONE_API_KEY is unset.
    if (member.profile && Object.keys(member.profile).length) {
      try {
        await upsertMemberVector(id, member.profile);
      } catch (err) {
        console.error("create-member embed error:", err?.message || err);
      }
    }

    // Strip PII the same way marketplace-member does.
    const { profile = {}, phone: _topPhone, ...rest } = member;
    const { phone, email, businessPhone, ...safeProfile } = profile;
    return {
      statusCode: 201,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, member: { ...rest, profile: safeProfile } }),
    };
  } catch (err) {
    console.error("marketplace-create-member error:", err?.message || err);
    return { statusCode: 500, body: JSON.stringify({ error: "Failed to create member" }) };
  }
};
