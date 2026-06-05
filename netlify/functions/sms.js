import OpenAI from "openai";
import crypto from "crypto";
import { buildSystemPrompt, isOnboarded } from "./lib/systemPrompt.js";
import { parseCompletion } from "./lib/profileTool.js";
import { loadConversation, loadMember, saveMember, getDb } from "./lib/db.js";
import { FieldValue } from "firebase-admin/firestore";
import { upsertMemberVector } from "./lib/vectorSearch.js";
import { parsePriceRange, normalizePricePerProduct } from "./lib/priceParse.js";
import { loadAwaitingOutcome, recordOutcome } from "./lib/matchLog.js";
import { extractOutcome } from "./lib/extractOutcome.js";
import { shouldRecommend, makeFirstRecommendations, runConnectorSearch } from "./lib/recommend.js";
import { enqueuePostSave } from "./lib/triggerPostSave.js";
import { initObservability, captureError, trackEvent, flushObservability } from "./lib/observability.js";

initObservability({ context: "sms" });

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MAX_HISTORY = 20;
const TELNYX_TIMESTAMP_TOLERANCE_S = 5 * 60;

// Wrap Telnyx's raw 32-byte ed25519 public key (base64) in DER SPKI so
// Node's crypto.verify accepts it without an external dep.
function ed25519PublicKey(b64) {
  const raw = Buffer.from(b64, "base64");
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
  return crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
}

function verifyTelnyxSignature(event) {
  const pub = process.env.TELNYX_PUBLIC_KEY;
  if (!pub) return false;
  const sig = event.headers?.["telnyx-signature-ed25519"];
  const ts = event.headers?.["telnyx-timestamp"];
  if (!sig || !ts) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(ts, 10)) > TELNYX_TIMESTAMP_TOLERANCE_S) return false;
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : (event.body || "");
  const message = Buffer.from(`${ts}|${rawBody}`);
  try {
    return crypto.verify(null, message, ed25519PublicKey(pub), Buffer.from(sig, "base64"));
  } catch {
    return false;
  }
}

async function sendSms(to, from, text) {
  const res = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, text }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Telnyx send failed: ${res.status} ${err}`);
  }
}

export const handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  if (!verifyTelnyxSignature(event)) {
    console.error("SMS webhook signature verification failed");
    return { statusCode: 401, body: "Unauthorized" };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 200, body: "OK" };
  }

  const eventType = body?.data?.event_type;
  if (eventType !== "message.received") {
    return { statusCode: 200, body: "OK" };
  }

  const payload = body.data?.payload;
  const fromNumber = payload?.from?.phone_number;
  const toNumber = payload?.to?.[0]?.phone_number;
  const incomingText = payload?.text?.trim();

  if (!fromNumber || !incomingText) {
    return { statusCode: 200, body: "OK" };
  }

  const replyFrom = toNumber || process.env.TELNYX_FROM_NUMBER;

  // Idempotency: Telnyx retries webhooks on non-2xx and sometimes
  // duplicates on flaky networks. A second pass through this handler
  // would re-run GPT, double-append history, and potentially fire
  // duplicate recommendations. Reserve the event id atomically — if
  // another instance already saw it, ack OK and bail.
  const webhookId = body.data?.id || payload?.id;
  if (webhookId) {
    try {
      await getDb().collection("webhookEvents").doc(`telnyx_${webhookId}`).create({
        source: "telnyx",
        seenAt: FieldValue.serverTimestamp(),
      });
    } catch {
      return { statusCode: 200, body: "OK (duplicate)" };
    }
  }

  try {
    const awaiting = await loadAwaitingOutcome(fromNumber);
    if (awaiting) {
      const outcome = await extractOutcome(incomingText, { reason: awaiting.reason });
      await recordOutcome(awaiting.id, { raw: incomingText, outcome });

      trackEvent(fromNumber, "outcome_received", {
        channel: "sms",
        matchLogId: awaiting.id,
        attended: outcome?.attended ?? null,
        sentiment: outcome?.sentiment ?? null,
        would_repeat: outcome?.would_repeat ?? null,
      });

      const implicit = outcome?.implicit_profile_updates;
      if (implicit && Object.keys(implicit).length) {
        await saveMember(fromNumber, { profileUpdate: implicit });
        try {
          const member = await loadMember(fromNumber);
          if (member?.profile) await upsertMemberVector(fromNumber, member.profile);
        } catch (err) { console.error("Embed after outcome error:", err); }
      }

      const ack = "Thanks for letting us know — that really helps us find better connections for you.";
      const history = await loadConversation(fromNumber);
      history.push({ role: "user", content: incomingText });
      history.push({ role: "assistant", content: ack });
      await saveMember(fromNumber, { history, meta: { phone: fromNumber, source: "sms" } });
      await sendSms(fromNumber, replyFrom, ack);
      await flushObservability();
      return { statusCode: 200, body: "OK" };
    }

    let history = await loadConversation(fromNumber);
    history.push({ role: "user", content: incomingText });
    if (history.length > MAX_HISTORY) {
      history = history.slice(history.length - MAX_HISTORY);
    }

    // Pick the prompt from the member's current profile: onboarding interview
    // until first recs fire, connector mode after.
    const existing = await loadMember(fromNumber);
    const connectorMode = isOnboarded(existing?.profile);

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 300,
      messages: [{ role: "system", content: buildSystemPrompt(existing?.profile, { sms: true }) }, ...history],
      response_format: { type: "json_object" },
    });

    const { reply, profileUpdate, searchQuery } = parseCompletion(completion);
    let replyText = reply || "Sorry, something went wrong. Please try again.";

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
    await saveMember(fromNumber, { profileUpdate: normalizedUpdate, meta: { phone: fromNumber, source: "sms" } });

    try {
      const member = await loadMember(fromNumber);
      if (member?.profile) {
        await upsertMemberVector(fromNumber, member.profile);

        if (connectorMode) {
          if (searchQuery) {
            try {
              const recs = await runConnectorSearch(fromNumber, member.profile, searchQuery, { channel: "sms" });
              if (recs?.paragraph) replyText = `${replyText}\n\n${recs.paragraph}`;
              else replyText = `${replyText}\n\nCouldn't find a match for that just yet — I'll keep an eye out as new folks join!`;
            } catch (err) {
              console.error("runConnectorSearch error:", err);
            }
          }
        } else if (shouldRecommend(member.profile)) {
          trackEvent(fromNumber, "profile_completed", {
            channel: "sms",
            memberType: member.profile.memberType,
            city: member.profile.city ?? null,
          });
          try {
            const recs = await makeFirstRecommendations(fromNumber, member.profile, { channel: "sms" });
            if (recs?.paragraph) {
              replyText = `${replyText}\n\n${recs.paragraph}`;
              await saveMember(fromNumber, { profileUpdate: { firstRecsMadeAt: new Date().toISOString() } });
              trackEvent(fromNumber, "first_recs_sent", {
                channel: "sms",
                memberType: member.profile.memberType,
                recCount: recs.logs?.length ?? null,
              });
            }
          } catch (err) {
            captureError(err, { fn: "sms", step: "makeFirstRecommendations", phone: fromNumber });
          }
        }

        // Heavy background work runs in a Trigger.dev task so it survives
        // past this webhook returning (subscriptions, location parse,
        // cross-ref verification, enrichment). See trigger/post-save-pipeline.ts.
        await enqueuePostSave(fromNumber, profileUpdate, "sms");
      }
    } catch (err) {
      captureError(err, { fn: "sms", step: "embed-recommend", phone: fromNumber });
    }

    history.push({ role: "assistant", content: replyText });
    await saveMember(fromNumber, { history, meta: { phone: fromNumber, source: "sms" } });

    await sendSms(fromNumber, replyFrom, replyText);
  } catch (err) {
    captureError(err, { fn: "sms", step: "top-level", phone: fromNumber });
    try {
      await sendSms(fromNumber, replyFrom, "Sorry, something went wrong. Please try again in a moment.");
    } catch {
      // ignore
    }
  }

  await flushObservability();
  return { statusCode: 200, body: "OK" };
};
