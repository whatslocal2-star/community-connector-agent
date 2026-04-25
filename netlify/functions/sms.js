import OpenAI from "openai";
import { getStore } from "@netlify/blobs";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are a warm, friendly community connector for a local marketplace platform. Your job is to onboard new members — either vendors (businesses) or shoppers — and gather the info needed to connect them with their community.

CONVERSATION FLOW:
1. When a user sends their first message, greet them warmly and ask: "Are you joining us as a vendor/business, or as a shopper?"

2. If VENDOR:
   - Thank them and ask for a link to their business (Google Maps listing, Shopify store, website, Instagram, or any link)
   - Once they share a link, tell them you'll use it to set up their profile
   - Ask what they'd like to share with their community (e.g. deals, new arrivals, events, announcements)
   - Wrap up warmly, confirm you'll get their profile set up

3. If SHOPPER:
   - Ask what kinds of things they're into (e.g. fashion, food, local crafts, electronics, wellness, etc.)
   - Ask how they'd like to stay connected: notifications for deals, a weekly digest, or discovering new local shops
   - Wrap up warmly and let them know you'll match them with relevant vendors

RULES:
- Keep responses SHORT — this is SMS, aim for 1-3 sentences max
- Ask ONE question at a time
- Be warm and encouraging
- If someone seems unsure, gently guide them
- Never ask for personal info beyond what's needed (no address, payment info)`;

const MAX_HISTORY = 20;

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
  // Telnyx expects a 200 quickly; errors get logged but we still return 200
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 200, body: "OK" };
  }

  // Only handle inbound messages
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
    // Load conversation history for this phone number
    const store = getStore("sms-conversations");
    let history = [];
    try {
      const stored = await store.get(fromNumber, { type: "json" });
      if (Array.isArray(stored)) history = stored;
    } catch {
      // no prior history
    }

    history.push({ role: "user", content: incomingText });

    // Keep history bounded
    if (history.length > MAX_HISTORY) {
      history = history.slice(history.length - MAX_HISTORY);
    }

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 300,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history],
    });

    const reply = completion.choices[0]?.message?.content ?? "Sorry, something went wrong. Please try again.";

    history.push({ role: "assistant", content: reply });
    await store.set(fromNumber, JSON.stringify(history));

    await sendSms(fromNumber, replyFrom, reply);
  } catch (err) {
    console.error("SMS handler error:", err);
    // Best-effort fallback reply
    try {
      await sendSms(fromNumber, replyFrom, "Sorry, something went wrong on our end. Please try again in a moment.");
    } catch {
      // ignore
    }
  }

  return { statusCode: 200, body: "OK" };
};
