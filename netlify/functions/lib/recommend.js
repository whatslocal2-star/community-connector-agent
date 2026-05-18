import OpenAI from "openai";
import { searchMembers } from "./search.js";
import { createMatchLog } from "./matchLog.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Decide whether this member has enough profile signal to receive a
// first round of recommendations.
export function shouldRecommend(profile) {
  if (!profile) return false;
  if (profile.firstRecsMadeAt) return false;
  if (!profile.name || !profile.memberType) return false;
  const richness = [
    profile.city,
    profile.neighborhood,
    profile.businessCategory,
    profile.category,
    profile.cause,
    profile.discipline,
    profile.niche,
    profile.interests?.length,
    profile.goals?.length,
    profile.services?.length,
    profile.products?.length,
  ].filter(Boolean).length;
  return richness >= 2;
}

function buildQueryFromProfile(profile) {
  const parts = [];
  if (profile.memberType) parts.push(`looking for community matches for a ${profile.memberType}`);
  if (profile.businessDescription) parts.push(profile.businessDescription);
  if (profile.cause) parts.push(`cause: ${profile.cause}`);
  if (profile.discipline) parts.push(profile.discipline);
  if (profile.niche) parts.push(profile.niche);
  if (profile.interests?.length) parts.push(`interests: ${profile.interests.join(", ")}`);
  if (profile.services?.length) parts.push(`offers: ${profile.services.join(", ")}`);
  if (profile.products?.length) parts.push(`sells: ${profile.products.join(", ")}`);
  if (profile.goals?.length) parts.push(`wants: ${profile.goals.join(", ")}`);
  if (profile.vibe) parts.push(`vibe: ${profile.vibe}`);
  if (profile.neighborhood) parts.push(profile.neighborhood);
  if (profile.city) parts.push(profile.city);
  return parts.join(". ");
}

const RECO_BLURB_PROMPT = `You write short, warm recommendation blurbs for a community matchmaker.

Given a member and a list of 1-3 candidate people we found for them, write a single conversational paragraph (~3-5 sentences) that:
- naturally weaves in each candidate's name and a one-line reason why we picked them
- feels like a friend giving an intro, not a directory listing
- ends with a low-pressure prompt like "want us to make any of these intros?"

Return JSON: { "paragraph": "..." }`;

async function writeRecoParagraph(memberProfile, candidates) {
  if (!candidates.length) return null;
  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 350,
      messages: [
        { role: "system", content: RECO_BLURB_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            member: {
              name: memberProfile.name,
              memberType: memberProfile.memberType,
              city: memberProfile.city,
              interests: memberProfile.interests,
              cause: memberProfile.cause,
              vibe: memberProfile.vibe,
            },
            candidates: candidates.map(c => ({
              name: c.profile?.name,
              memberType: c.profile?.memberType,
              category: c.profile?.businessCategory || c.profile?.category,
              vibe: c.profile?.vibe,
              description: c.profile?.businessDescription || c.profile?.approvedBlurb,
              neighborhood: c.profile?.neighborhood,
            })),
          }),
        },
      ],
      response_format: { type: "json_object" },
    });
    const parsed = JSON.parse(completion.choices[0].message.content);
    return parsed.paragraph || null;
  } catch (err) {
    console.error("writeRecoParagraph error:", err);
    return null;
  }
}

function reasonFor(memberProfile, candidate) {
  const p = candidate.profile || {};
  const bits = [];
  if (memberProfile.city && p.city && p.city.toLowerCase() === memberProfile.city.toLowerCase()) {
    bits.push(`same city (${p.city})`);
  }
  if (p.businessCategory) bits.push(p.businessCategory);
  else if (p.discipline) bits.push(p.discipline);
  else if (p.cause) bits.push(`cause: ${p.cause}`);
  if (p.vibe) bits.push(`vibe: ${p.vibe}`);
  return bits.join(" · ") || "semantic match on profile";
}

// Run a first-time recommendation round for a member.
// Returns { paragraph, logs: [{id, matchedMemberId, name}] } or null.
export async function makeFirstRecommendations(memberId, memberProfile, { channel = "web", limit = 3 } = {}) {
  const query = buildQueryFromProfile(memberProfile);
  if (!query) return null;

  const { results } = await searchMembers({
    query,
    excludeIds: [memberId],
    limit,
  });

  const candidates = results.filter(r => r.id !== memberId).slice(0, limit);
  if (!candidates.length) return null;

  const paragraph = await writeRecoParagraph(memberProfile, candidates);

  const logs = [];
  for (const c of candidates) {
    try {
      const id = await createMatchLog({
        memberId,
        memberName: memberProfile.name ?? null,
        matchedMemberId: c.id,
        matchedMemberName: c.profile?.name ?? null,
        reason: reasonFor(memberProfile, c),
        channel,
      });
      logs.push({ id, matchedMemberId: c.id, name: c.profile?.name });
    } catch (err) {
      console.error("createMatchLog error:", err);
    }
  }

  return { paragraph, logs };
}
