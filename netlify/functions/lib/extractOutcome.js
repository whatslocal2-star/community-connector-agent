import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const OUTCOME_PROMPT = `You are extracting structured signal from a community member's natural-language reply about a connection or recommendation we made for them.

Return a JSON object with these fields (omit any you can't infer):
- attended: boolean — did they actually meet, visit, or follow through?
- sentiment: number 0.0–1.0 — overall positive/negative tone
- reasons_positive: array of short strings — what they liked
- reasons_negative: array of short strings — friction, concerns, complaints
- would_repeat: boolean — would they do this again / want more like it?
- implicit_profile_updates: object — facts about the member revealed in the reply (e.g. { priceRange: "budget-conscious", interests: ["sustainable fashion"] }). Use canonical schema field names. Empty object if none.
- summary: one short sentence capturing what happened.

Return valid JSON only.`;

export async function extractOutcome(replyText, context = {}) {
  try {
    const userMsg = context.reason
      ? `Original intro reason: ${context.reason}\n\nMember reply:\n${replyText}`
      : `Member reply:\n${replyText}`;
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 400,
      messages: [
        { role: "system", content: OUTCOME_PROMPT },
        { role: "user", content: userMsg },
      ],
      response_format: { type: "json_object" },
    });
    return JSON.parse(completion.choices[0].message.content);
  } catch (err) {
    console.error("extractOutcome error:", err);
    return null;
  }
}
