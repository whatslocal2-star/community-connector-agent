import OpenAI from "openai";
import { SYSTEM_PROMPT } from "./lib/systemPrompt.js";
import { parseCompletion } from "./lib/profileTool.js";
import { saveMember, loadMember, saveSubscriptions } from "./lib/db.js";
import { upsertMemberVector } from "./lib/vectorSearch.js";
import { syncToProlocaliq, isReadyToSync } from "./lib/syncToProlocaliq.js";
import { enrichProfile, hasEnrichableData } from "./lib/enrich.js";
import { buildSubscriptionsFromProfile, hasNewSubscriptionData } from "./lib/subscriptions.js";
import { parseGoogleMapsUrl } from "./lib/parseLocation.js";
import { loadAwaitingOutcome, recordOutcome } from "./lib/matchLog.js";
import { extractOutcome } from "./lib/extractOutcome.js";
import { shouldRecommend, makeFirstRecommendations } from "./lib/recommend.js";
import { parsePriceRange, normalizePricePerProduct } from "./lib/priceParse.js";
import { shouldCrossRef, runCrossRefVerify } from "./lib/verifyCrossRef.js";
import { initObservability, captureError, trackEvent, flushObservability } from "./lib/observability.js";

initObservability({ context: "chat" });

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { ...corsHeaders }, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: { ...corsHeaders }, body: "Method Not Allowed" };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers: { ...corsHeaders }, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const { messages, sessionId } = body;
  if (!Array.isArray(messages)) {
    return { statusCode: 400, headers: { ...corsHeaders }, body: JSON.stringify({ error: "messages must be an array" }) };
  }

  try {
    if (sessionId) {
      const awaiting = await loadAwaitingOutcome(sessionId);
      const lastUserMsg = [...messages].reverse().find(m => m.role === "user")?.content;
      if (awaiting && lastUserMsg) {
        const outcome = await extractOutcome(lastUserMsg, { reason: awaiting.reason });
        await recordOutcome(awaiting.id, { raw: lastUserMsg, outcome });

        const implicit = outcome?.implicit_profile_updates;
        if (implicit && Object.keys(implicit).length) {
          await saveMember(sessionId, { profileUpdate: implicit, meta: { source: "web" } });
          try {
            const member = await loadMember(sessionId);
            if (member?.profile) await upsertMemberVector(sessionId, member.profile);
          } catch (err) { console.error("Embed after outcome error:", err); }
        }

        trackEvent(sessionId, "outcome_received", {
          channel: "web",
          matchLogId: awaiting.id,
          attended: outcome?.attended ?? null,
          sentiment: outcome?.sentiment ?? null,
          would_repeat: outcome?.would_repeat ?? null,
        });
        const ack = "Thanks for sharing that — it really helps us find better connections for you.";
        const updatedHistory = [...messages, { role: "assistant", content: ack }];
        await saveMember(sessionId, { history: updatedHistory, meta: { source: "web" } });
        return {
          statusCode: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ reply: ack }),
        };
      }
    }

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 512,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
      response_format: { type: "json_object" },
    });

    const { reply, profileUpdate } = parseCompletion(completion);
    let finalReply = reply;

    if (sessionId) {
      try {
        // Normalize structured fields before save so search filters work.
        let normalizedUpdate = profileUpdate;
        if (profileUpdate && typeof profileUpdate === "object") {
          normalizedUpdate = { ...profileUpdate };
          if (profileUpdate.priceRange && profileUpdate.priceMin == null && profileUpdate.priceMax == null) {
            const parsed = parsePriceRange(profileUpdate.priceRange);
            if (parsed) Object.assign(normalizedUpdate, parsed);
          }
          if (profileUpdate.pricePerProduct) {
            normalizedUpdate.pricePerProduct = normalizePricePerProduct(profileUpdate.pricePerProduct);
          }
        }
        await saveMember(sessionId, { profileUpdate: normalizedUpdate, meta: { source: "web" } });
        const member = await loadMember(sessionId);
        if (member?.profile) {
          await upsertMemberVector(sessionId, member.profile);

          if (shouldRecommend(member.profile)) {
            try {
              const recs = await makeFirstRecommendations(sessionId, member.profile, { channel: "web" });
              if (recs?.paragraph) {
                finalReply = `${reply}\n\n${recs.paragraph}`;
                await saveMember(sessionId, { profileUpdate: { firstRecsMadeAt: new Date().toISOString() } });
                trackEvent(sessionId, "first_recs_sent", {
                  channel: "web",
                  memberType: member.profile.memberType,
                  recCount: recs.matches?.length ?? null,
                });
              }
            } catch (err) {
              captureError(err, { fn: "chat", step: "makeFirstRecommendations", sessionId });
            }
          }

          if (profileUpdate && !member.profile.firstRecsMadeAt && shouldRecommend(member.profile)) {
            trackEvent(sessionId, "profile_completed", {
              channel: "web",
              memberType: member.profile.memberType,
              city: member.profile.city ?? null,
            });
          }

          const updatedHistory = [...messages, { role: "assistant", content: finalReply }];
          await saveMember(sessionId, { history: updatedHistory, meta: { source: "web" } });

          if (hasNewSubscriptionData(profileUpdate)) {
            const subs = buildSubscriptionsFromProfile(member.profile);
            if (subs.length) {
              saveSubscriptions(sessionId, subs).catch(err =>
                console.error("Subscription save error:", err)
              );
            }
          }

          if (profileUpdate?.googleMapsUrl && !member.profile.latitude) {
            parseGoogleMapsUrl(profileUpdate.googleMapsUrl).then(async (coords) => {
              if (coords) {
                await saveMember(sessionId, { profileUpdate: coords });
              }
            }).catch(err => console.error("Location parse error:", err));
          }

          if (shouldCrossRef(member.profile)) {
            runCrossRefVerify(sessionId, member.profile).catch(err =>
              console.error("Cross-ref verify error:", err)
            );
          }

          if (hasEnrichableData(profileUpdate) && !member.profile.enrichedAt) {
            enrichProfile(member.profile).then(async (enriched) => {
              if (!enriched) return;
              const safeFields = {};
              for (const [k, v] of Object.entries(enriched)) {
                if (v != null && !member.profile[k]) safeFields[k] = v;
              }
              if (Object.keys(safeFields).length) {
                await saveMember(sessionId, { profileUpdate: { ...safeFields, enrichedAt: new Date().toISOString() } });
              }
            }).catch(err => console.error("Background enrich error:", err));
          }

          if (isReadyToSync(member.profile)) {
            const result = await syncToProlocaliq(sessionId, member.profile);
            if (result?.status === "created" || result?.status === "already_exists") {
              await saveMember(sessionId, { profileUpdate: { prolocaliqSynced: true, prolocaliqAccountId: result.businessAccountId ?? null } });
            }
          }
        }
      } catch (err) {
        console.error("Save/embed error:", err);
        captureError(err, { fn: "chat", step: "save-embed-pipeline", sessionId });
      }
    }

    await flushObservability();

    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ reply: finalReply }),
    };
  } catch (err) {
    console.error("OpenAI error:", err);
    captureError(err, { fn: "chat", step: "top-level", sessionId });
    await flushObservability();
    return {
      statusCode: 500,
      headers: { ...corsHeaders },
      body: JSON.stringify({ error: "Something went wrong. Please try again." }),
    };
  }
};
