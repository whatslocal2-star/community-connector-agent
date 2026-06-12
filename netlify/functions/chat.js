import OpenAI from "openai";
import { buildSystemPrompt, isOnboarded } from "./lib/systemPrompt.js";
import { parseCompletion } from "./lib/profileTool.js";
import { saveMember, loadMember } from "./lib/db.js";
import { loadCollabsByIds, pendingOptionsFor, recordCollabResponse } from "./lib/collabs.js";
import { assessPool, recordNudged } from "./lib/collabActivity.js";
import { upsertMemberVector } from "./lib/vectorSearch.js";
import { loadAwaitingOutcome, recordOutcome } from "./lib/matchLog.js";
import { extractOutcome } from "./lib/extractOutcome.js";
import { shouldRecommend, makeFirstRecommendations, runConnectorSearch } from "./lib/recommend.js";
import { parsePriceRange, normalizePricePerProduct } from "./lib/priceParse.js";
import { enqueuePostSave } from "./lib/triggerPostSave.js";
import { enforceRateLimit } from "./lib/rateLimit.js";
import { initObservability, captureError, trackEvent, flushObservability } from "./lib/observability.js";

initObservability({ context: "chat" });

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

  // Public + unauthenticated; every turn calls OpenAI (+ Pinecone on recs).
  // Cap per-IP so a curl loop can't run up spend or trip Firestore quota.
  const limited = await enforceRateLimit(event, { name: "chat", limit: 30, windowSec: 60 });
  if (limited) return limited;

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

        trackEvent(sessionId, "outcome_received", {
          channel: "web",
          matchLogId: awaiting.id,
          attended: outcome?.attended ?? null,
          sentiment: outcome?.sentiment ?? null,
          would_repeat: outcome?.would_repeat ?? null,
        });

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
        await flushObservability();
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

    // Pending collab options the admin approved for this member — surfaced to
    // the SAME connector persona so relaying an invite feels seamless.
    let pendingOptions = [];
    if (connectorMode && existing?.pendingCollabs?.length) {
      try {
        const collabs = await loadCollabsByIds(existing.pendingCollabs);
        pendingOptions = pendingOptionsFor(collabs, sessionId);
      } catch (err) { console.error("load pending collabs error:", err); }
    }

    // Gently recalibrate members who keep passing on collabs (active, still in
    // the pool). Stamp nudgedAt so we don't ask more than weekly.
    const recalibrate = connectorMode ? assessPool(existing).shouldNudge : false;
    if (recalibrate) {
      try { await recordNudged(sessionId); } catch (err) { console.error("recordNudged error:", err); }
    }

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 512,
      messages: [{ role: "system", content: buildSystemPrompt(existing?.profile, { sms: false, pendingCollabs: pendingOptions, recalibrate }) }, ...cappedMessages],
      response_format: { type: "json_object" },
    });

    const { reply, profileUpdate, searchQuery, collabResponses } = parseCompletion(completion);
    let finalReply = reply;

    // Record any collab option the member responded to this turn, and clear it
    // from their pending list. Independent of the profile save pipeline.
    if (collabResponses?.length) {
      for (const r of collabResponses) {
        try {
          await recordCollabResponse(r.collabId, sessionId, { decision: r.decision, note: r.note ?? null });
        } catch (err) { console.error("recordCollabResponse error:", err); }
      }
      trackEvent(sessionId, "collab_response", { channel: "web", count: collabResponses.length });
    }

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
            // Member just crossed the completeness threshold for first recs.
            trackEvent(sessionId, "profile_completed", {
              channel: "web",
              memberType: member.profile.memberType,
              city: member.profile.city ?? null,
            });
            try {
              const recs = await makeFirstRecommendations(sessionId, member.profile, { channel: "web" });
              if (recs?.paragraph) {
                finalReply = `${reply}\n\n${recs.paragraph}`;
                await saveMember(sessionId, { profileUpdate: { firstRecsMadeAt: new Date().toISOString() } });
                trackEvent(sessionId, "first_recs_sent", {
                  channel: "web",
                  memberType: member.profile.memberType,
                  recCount: recs.logs?.length ?? null,
                });
              }
            } catch (err) {
              captureError(err, { fn: "chat", step: "makeFirstRecommendations", sessionId });
            }
          }

          const updatedHistory = capHistory([...cappedMessages, { role: "assistant", content: finalReply }]);
          await saveMember(sessionId, { history: updatedHistory, meta: { source: "web" } });

          // Heavy background work (subscriptions, location parse, cross-ref
          // verification, enrichment) runs in a Trigger.dev task so it survives
          // past the Netlify function returning. The task reloads the member
          // and decides which steps to run.
          await enqueuePostSave(sessionId, profileUpdate, "web");
        }
      } catch (err) {
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
    captureError(err, { fn: "chat", step: "top-level", sessionId });
    await flushObservability();
    return {
      statusCode: 500,
      headers: { ...corsHeaders },
      body: JSON.stringify({ error: "Something went wrong. Please try again." }),
    };
  }
};
