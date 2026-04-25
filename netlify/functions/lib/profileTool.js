export function parseCompletion(completion) {
  const raw = completion.choices[0]?.message?.content ?? "{}";
  try {
    const parsed = JSON.parse(raw);
    const reply = parsed.reply ?? "";
    const profileUpdate = parsed.profileUpdate && Object.keys(parsed.profileUpdate).length
      ? parsed.profileUpdate
      : null;
    return { reply, profileUpdate };
  } catch {
    // model didn't return valid JSON — treat the whole thing as a reply
    return { reply: raw, profileUpdate: null };
  }
}
