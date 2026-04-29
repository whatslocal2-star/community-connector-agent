import OpenAI from "openai";
import { SYSTEM_PROMPT } from "./lib/systemPrompt.js";
import { parseCompletion } from "./lib/profileTool.js";
import { loadConversation, loadMember, saveMember } from "./lib/db.js";
import { upsertMemberVector } from "./lib/vectorSearch.js";

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
    const replyText = reply || "Sorry, something went wrong. Please try again.";

    history.push({ role: "assistant", content: replyText });

    await saveMember(fromNumber, {
      history,
      profileUpdate,
      meta: { phone: fromNumber, source: "sms" },
    });

    if (profileUpdate) {
      try {
        const member = await loadMember(fromNumber);
        if (member?.profile) await upsertMemberVector(fromNumber, member.profile);
      } catch (err) {
        console.error("Embed error:", err);
      }
    }

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
