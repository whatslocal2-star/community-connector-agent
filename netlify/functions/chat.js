import OpenAI from "openai";

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
- Keep responses SHORT and conversational — like a friendly text exchange
- Ask ONE question at a time
- Be warm and encouraging
- If someone seems unsure, gently guide them
- Never ask for personal info beyond what's needed (no phone, address, payment info)`;

export const handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const { messages } = body;
  if (!Array.isArray(messages)) {
    return { statusCode: 400, body: JSON.stringify({ error: "messages must be an array" }) };
  }

  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 512,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
    });

    const reply = completion.choices[0]?.message?.content ?? "";

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply }),
    };
  } catch (err) {
    console.error("OpenAI error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Something went wrong. Please try again." }),
    };
  }
};
