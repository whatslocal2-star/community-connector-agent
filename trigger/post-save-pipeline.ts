import { task } from "@trigger.dev/sdk";
import { loadMember, saveMember, saveSubscriptions } from "../netlify/functions/lib/db.js";
import { buildSubscriptionsFromProfile, hasNewSubscriptionData } from "../netlify/functions/lib/subscriptions.js";
import { parseGoogleMapsUrl } from "../netlify/functions/lib/parseLocation.js";
import { shouldCrossRef, runCrossRefVerify } from "../netlify/functions/lib/verifyCrossRef.js";
import { enrichProfile, hasEnrichableData } from "../netlify/functions/lib/enrich.js";

type Payload = {
  memberId: string;
  profileUpdate?: Record<string, any> | null;
  channel?: string;
};

// Reliable replacement for the fire-and-forget post-save work that used to
// run (and get killed) inside chat.js / sms.js. Each turn the handler saves
// the profile + embeds synchronously, then enqueues this task. We reload the
// member fresh here so every step sees the merged profile, and use the raw
// profileUpdate from the turn to decide which steps are worth running.
export const postSavePipeline = task({
  id: "post-save-pipeline",
  run: async ({ memberId, profileUpdate }: Payload) => {
    const member = await loadMember(memberId);
    if (!member?.profile) return { memberId, skipped: "no profile" };

    const profile = member.profile as Record<string, any>;
    const update = profileUpdate || {};
    const results: Record<string, any> = {};

    // 1. Event-source subscriptions from captured posting platforms / handles.
    if (hasNewSubscriptionData(update)) {
      const subs = buildSubscriptionsFromProfile(profile);
      if (subs.length) {
        await saveSubscriptions(memberId, subs);
        results.subscriptions = subs.length;
      }
    }

    // 2. Resolve a Google Maps URL to lat/lng if we don't have coords yet.
    if (update.googleMapsUrl && !profile.latitude) {
      const coords = await parseGoogleMapsUrl(update.googleMapsUrl);
      if (coords) {
        await saveMember(memberId, { profileUpdate: coords });
        Object.assign(profile, coords);
        results.location = coords;
      }
    }

    // 3. Cross-reference verification (Gemini) once enough channels captured.
    if (shouldCrossRef(profile)) {
      const verification = await runCrossRefVerify(memberId, profile);
      if (verification) {
        profile.ownershipVerification = verification;
        results.crossRef = { verified: verification.verified, confidence: verification.confidence };
      }
    }

    // 4. Profile enrichment — only fills empty fields, never overwrites.
    if (hasEnrichableData(update) && !profile.enrichedAt) {
      const enriched = await enrichProfile(profile);
      if (enriched) {
        const safeFields: Record<string, any> = {};
        for (const [k, v] of Object.entries(enriched)) {
          if (v != null && !profile[k]) safeFields[k] = v;
        }
        if (Object.keys(safeFields).length) {
          await saveMember(memberId, { profileUpdate: { ...safeFields, enrichedAt: new Date().toISOString() } });
          Object.assign(profile, safeFields);
          results.enriched = Object.keys(safeFields);
        }
      }
    }

    // (ProLocalIQ sync removed — that integration is deprecated. The
    // syncToProlocaliq lib remains unused in case it's ever revived.)

    return { memberId, ...results };
  },
});
