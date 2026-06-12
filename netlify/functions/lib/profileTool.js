export function parseCompletion(completion) {
  const raw = completion.choices[0]?.message?.content ?? "{}";
  try {
    const parsed = JSON.parse(raw);
    const reply = parsed.reply ?? "";
    const profileUpdate = parsed.profileUpdate && Object.keys(parsed.profileUpdate).length
      ? parsed.profileUpdate
      : null;
    // Connector mode only — natural-language "find me X" request. Onboarding
    // never sets this. Trim and treat empty strings as absent.
    const searchQuery = typeof parsed.searchQuery === "string" && parsed.searchQuery.trim()
      ? parsed.searchQuery.trim()
      : null;
    // Connector mode only — the member's response to one or more pending collab
    // options. Keep only well-formed entries with a collabId + decision.
    const collabResponses = Array.isArray(parsed.collabResponses)
      ? parsed.collabResponses.filter(r => r && typeof r.collabId === "string" && r.collabId && typeof r.decision === "string" && r.decision)
      : null;
    return { reply, profileUpdate, searchQuery, collabResponses: collabResponses?.length ? collabResponses : null };
  } catch {
    // model didn't return valid JSON — treat the whole thing as a reply
    return { reply: raw, profileUpdate: null, searchQuery: null, collabResponses: null };
  }
}
