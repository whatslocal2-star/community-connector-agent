import OpenAI from "openai";
import { SYSTEM_PROMPT } from "./lib/systemPrompt.js";
import { parseCompletion } from "./lib/profileTool.js";
import { saveMember } from "./lib/db.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

  const { messages, sessionId } = body;
  if (!Array.isArray(messages)) {
    return { statusCode: 400, body: JSON.stringify({ error: "messages must be an array" }) };
  }

  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 512,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
      response_format: { type: "json_object" },
    });

    const { reply, profileUpdate } = parseCompletion(completion);

    if (sessionId && profileUpdate) {
      saveMember(sessionId, {
        profileUpdate,
        meta: { source: "web" },
      }).catch(err => console.error("Firestore save error:", err));
    }

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
