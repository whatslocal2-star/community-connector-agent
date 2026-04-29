import OpenAI from "openai";
import { SYSTEM_PROMPT } from "./lib/systemPrompt.js";
import { parseCompletion } from "./lib/profileTool.js";
import { saveMember, loadMember } from "./lib/db.js";
import { upsertMemberVector } from "./lib/vectorSearch.js";

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

    if (sessionId && profileUpdate) {
      try {
        await saveMember(sessionId, { profileUpdate, meta: { source: "web" } });
        const member = await loadMember(sessionId);
        if (member?.profile) await upsertMemberVector(sessionId, member.profile);
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
