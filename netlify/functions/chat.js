import OpenAI from "openai";
import { buildSystemPrompt, isOnboarded } from "./lib/systemPrompt.js";
import { parseCompletion } from "./lib/profileTool.js";
import { saveMember, loadMember, saveSubscriptions } from "./lib/db.js";
import { upsertMemberVector } from "./lib/vectorSearch.js";
import { syncToProlocaliq, isReadyToSync } from "./lib/syncToProlocaliq.js";
import { enrichProfile, hasEnrichableData } from "./lib/enrich.js";
import { buildSubscriptionsFromProfile, hasNewSubscriptionData } from "./lib/subscriptions.js";
import { parseGoogleMapsUrl } from "./lib/parseLocation.js";
import { loadAwaitingOutcome, recordOutcome } from "./lib/matchLog.js";
import { extractOutcome } from "./lib/extractOutcome.js";
import { shouldRecommend, makeFirstRecommendations, runConnectorSearch } from "./lib/recommend.js";
import { parsePriceRange, normalizePricePerProduct } from "./lib/priceParse.js";
import { shouldCrossRef, runCrossRefVerify } from "./lib/verifyCrossRef.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MAX_HISTORY = 20;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const capHistory = (msgs) => msgs.slice(-MAX_HISTORY);

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
  if (!sessionId || typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
    return { statusCode: 400, headers: { ...corsHeaders }, body: JSON.stringify({ error: "sessionId (UUID) required" }) };
  }

  // Cap incoming history so a long-lived session can't push the Firestore
  // doc toward the 1MB limit (and to bound OpenAI token spend per turn).
  const cappedMessages = capHistory(messages);

  try {
    {
      const awaiting = await loadAwaitingOutcome(sessionId);
      const lastUserMsg = [...cappedMessages].reverse().find(m => m.role === "user")?.content;
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

        const ack = "Thanks for sharing that — it really helps us find better connections for you.";
        const updatedHistory = capHistory([...cappedMessages, { role: "assistant", content: ack }]);
        await saveMember(sessionId, { history: updatedHistory, meta: { source: "web" } });
        return {
          statusCode: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ reply: ack }),
        };
      }
    }

    // Pick the prompt for this turn from the member's CURRENT profile:
    // onboarding interview until first recs fire, connector mode after.
    const existing = await loadMember(sessionId);
    const connectorMode = isOnboarded(existing?.profile);

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 512,
      messages: [{ role: "system", content: buildSystemPrompt(existing?.profile, { sms: false }) }, ...cappedMessages],
      response_format: { type: "json_object" },
    });

    const { reply, profileUpdate, searchQuery } = parseCompletion(completion);
    let finalReply = reply;

    {
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

          if (connectorMode) {
            // Connector mode: only search when the model asked us to. Real
            // matches fetched + introduced in a 2nd pass; logged for learning.
            if (searchQuery) {
              try {
                const recs = await runConnectorSearch(sessionId, member.profile, searchQuery, { channel: "web" });
                if (recs?.paragraph) finalReply = `${reply}\n\n${recs.paragraph}`;
                else finalReply = `${reply}\n\nHmm, I couldn't find a great match in our community for that just yet — but new folks are joining all the time, so I'll keep an eye out. Anything else I can help you find?`;
              } catch (err) {
                console.error("runConnectorSearch error:", err);
              }
            }
          } else if (shouldRecommend(member.profile)) {
            try {
              const recs = await makeFirstRecommendations(sessionId, member.profile, { channel: "web" });
              if (recs?.paragraph) {
                finalReply = `${reply}\n\n${recs.paragraph}`;
                await saveMember(sessionId, { profileUpdate: { firstRecsMadeAt: new Date().toISOString() } });
              }
            } catch (err) {
              console.error("makeFirstRecommendations error:", err);
            }
          }

          const updatedHistory = capHistory([...cappedMessages, { role: "assistant", content: finalReply }]);
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
      }
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ reply: finalReply }),
    };
  } catch (err) {
    console.error("OpenAI error:", err);
    return {
      statusCode: 500,
      headers: { ...corsHeaders },
      body: JSON.stringify({ error: "Something went wrong. Please try again." }),
    };
  }
};
