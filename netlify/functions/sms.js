import OpenAI from "openai";
import { SYSTEM_PROMPT } from "./lib/systemPrompt.js";
import { parseCompletion } from "./lib/profileTool.js";
import { loadConversation, loadMember, saveMember } from "./lib/db.js";
import { upsertMemberVector } from "./lib/vectorSearch.js";
import { parsePriceRange, normalizePricePerProduct } from "./lib/priceParse.js";
import { syncToProlocaliq, isReadyToSync } from "./lib/syncToProlocaliq.js";
import { loadAwaitingOutcome, recordOutcome } from "./lib/matchLog.js";
import { extractOutcome } from "./lib/extractOutcome.js";
import { shouldRecommend, makeFirstRecommendations } from "./lib/recommend.js";
import { shouldCrossRef, runCrossRefVerify } from "./lib/verifyCrossRef.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MAX_HISTORY = 20;

const SMS_SYSTEM_PROMPT = SYSTEM_PROMPT.replace(
  "- Keep responses SHORT and conversational — like a friendly text exchange",
  "- Keep responses SHORT — this is SMS, 1-3 sentences max"
);

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

  try {
    const awaiting = await loadAwaitingOutcome(fromNumber);
    if (awaiting) {
      const outcome = await extractOutcome(incomingText, { reason: awaiting.reason });
      await recordOutcome(awaiting.id, { raw: incomingText, outcome });

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
      return { statusCode: 200, body: "OK" };
    }

    let history = await loadConversation(fromNumber);
    history.push({ role: "user", content: incomingText });
    if (history.length > MAX_HISTORY) {
      history = history.slice(history.length - MAX_HISTORY);
    }

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 300,
      messages: [{ role: "system", content: SMS_SYSTEM_PROMPT }, ...history],
      response_format: { type: "json_object" },
    });

    const { reply, profileUpdate } = parseCompletion(completion);
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

        if (shouldRecommend(member.profile)) {
          try {
            const recs = await makeFirstRecommendations(fromNumber, member.profile, { channel: "sms" });
            if (recs?.paragraph) {
              replyText = `${replyText}\n\n${recs.paragraph}`;
              await saveMember(fromNumber, { profileUpdate: { firstRecsMadeAt: new Date().toISOString() } });
            }
          } catch (err) {
            console.error("makeFirstRecommendations error:", err);
          }
        }

        if (shouldCrossRef(member.profile)) {
          runCrossRefVerify(fromNumber, member.profile).catch(err =>
            console.error("Cross-ref verify error:", err)
          );
        }

        if (isReadyToSync(member.profile)) {
          const result = await syncToProlocaliq(fromNumber, member.profile);
          if (result?.status === "created" || result?.status === "already_exists") {
            await saveMember(fromNumber, { profileUpdate: { prolocaliqSynced: true, prolocaliqAccountId: result.businessAccountId ?? null } });
          }
        }
      }
    } catch (err) {
      console.error("Embed/recommend error:", err);
    }

    history.push({ role: "assistant", content: replyText });
    await saveMember(fromNumber, { history, meta: { phone: fromNumber, source: "sms" } });

    await sendSms(fromNumber, replyFrom, replyText);
  } catch (err) {
    console.error("SMS handler error:", err);
    try {
      await sendSms(fromNumber, replyFrom, "Sorry, something went wrong. Please try again in a moment.");
    } catch {
      // ignore
    }
  }

  return { statusCode: 200, body: "OK" };
};
