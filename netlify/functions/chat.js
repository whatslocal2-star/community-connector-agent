import OpenAI from "openai";
import { SYSTEM_PROMPT } from "./lib/systemPrompt.js";
import { parseCompletion } from "./lib/profileTool.js";
import { saveMember, loadMember, saveSubscriptions } from "./lib/db.js";
import { upsertMemberVector } from "./lib/vectorSearch.js";
import { syncToProlocaliq, isReadyToSync } from "./lib/syncToProlocaliq.js";
import { enrichProfile, hasEnrichableData } from "./lib/enrich.js";
import { buildSubscriptionsFromProfile, hasNewSubscriptionData } from "./lib/subscriptions.js";
import { parseGoogleMapsUrl } from "./lib/parseLocation.js";

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
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 512,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
      response_format: { type: "json_object" },
    });

    const { reply, profileUpdate } = parseCompletion(completion);

    if (sessionId) {
      try {
        const updatedHistory = [...messages, { role: "assistant", content: reply }];
        await saveMember(sessionId, { history: updatedHistory, profileUpdate, meta: { source: "web" } });
        const member = await loadMember(sessionId);
        if (member?.profile) {
          await upsertMemberVector(sessionId, member.profile);

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
      body: JSON.stringify({ reply }),
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
