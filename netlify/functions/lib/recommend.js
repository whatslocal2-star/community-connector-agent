import OpenAI from "openai";
import { searchMembers } from "./search.js";
import { createMatchLog } from "./matchLog.js";
import { getDb } from "./db.js";
import { queryComplementary, buildNeedsText, buildOffersText } from "./vectorSearch.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const DIRECTION_LABEL = {
  they_offer_what_you_need: "offers what you're looking for",
  they_need_what_you_offer: "needs what you offer",
};

// Complementary matching: find members whose offers satisfy this member's
// needs (and vice versa), rather than members who are merely similar.
// Returns candidates shaped like searchMembers results, plus `directions`.
export async function findComplementaryMatches(memberId, profile, { limit = 3 } = {}) {
  const needsText = buildNeedsText(profile);
  const offersText = buildOffersText(profile);
  if (!needsText.trim() && !offersText.trim()) return [];

  const ranked = await queryComplementary({
    needsText,
    offersText,
    excludeIds: [memberId],
    limit: limit * 2,
  });
  if (!ranked.length) return [];

  const db = getDb();
  const refs = ranked.map(r => db.collection("members").doc(r.id));
  const snaps = await db.getAll(...refs);
  const byId = new Map(
    snaps.filter(s => s.exists).map(s => {
      const { history, ...rest } = s.data();
      return [s.id, { id: s.id, ...rest }];
    })
  );

  const out = [];
  for (const r of ranked) {
    const m = byId.get(r.id);
    if (!m?.profile) continue;
    const { phone, ...safeProfile } = m.profile;
    out.push({ id: r.id, score: r.score, directions: r.directions, profile: safeProfile });
    if (out.length >= limit) break;
  }
  return out;
}

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
    profile.needs?.length,
    profile.offers?.length,
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

const RECO_BLURB_PROMPT = `You write short, warm recommendation blurbs for a community matchmaker whose whole point is COMPLEMENTARY connections — pairing what one local member needs with what another offers, to spark collaborations and events.

Given a member and a list of 1-3 candidate people we found for them, write a single conversational paragraph (~3-5 sentences) that:
- naturally weaves in each candidate's name and the COMPLEMENTARY reason we picked them (each candidate has a "fit" describing how they complement the member — e.g. they offer what the member needs, or need what the member offers). Lean into that fit.
- frames it around what they could do together (a collab, an event, a cross-promo), not just "you're similar"
- feels like a friend giving an intro, not a directory listing
- ends with a low-pressure prompt like "want us to make any of these intros?"

Return JSON: { "paragraph": "..." }`;

function candidatePayload(c) {
  return {
    name: c.profile?.name,
    memberType: c.profile?.memberType,
    category: c.profile?.businessCategory || c.profile?.category,
    vibe: c.profile?.vibe,
    description: c.profile?.businessDescription || c.profile?.approvedBlurb,
    neighborhood: c.profile?.neighborhood,
    offers: c.profile?.offers,
    needs: c.profile?.needs,
    fit: (c.directions || []).map(d => DIRECTION_LABEL[d] || d),
  };
}

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
              needs: memberProfile.needs,
              offers: memberProfile.offers,
              cause: memberProfile.cause,
              vibe: memberProfile.vibe,
            },
            candidates: candidates.map(candidatePayload),
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
  // Complementary fit is the primary reason when present.
  for (const d of candidate.directions || []) {
    if (DIRECTION_LABEL[d]) bits.push(DIRECTION_LABEL[d]);
  }
  if (memberProfile.city && p.city && p.city.toLowerCase() === memberProfile.city.toLowerCase()) {
    bits.push(`same city (${p.city})`);
  }
  if (p.businessCategory) bits.push(p.businessCategory);
  else if (p.discipline) bits.push(p.discipline);
  else if (p.cause) bits.push(`cause: ${p.cause}`);
  return bits.join(" · ") || "semantic match on profile";
}

const CONNECTOR_BLURB_PROMPT = `You are a warm, plugged-in local community connector introducing a member to real people/places we just found for them.

You are given: the member, what they asked for, and 1-3 REAL candidates from our community directory. Write a single conversational paragraph (~3-5 sentences) that:
- directly answers their request, weaving in each candidate's real name and a one-line reason they're a great fit
- feels like a friend making a warm intro, not a directory listing
- uses ONLY the candidate details provided — never invent extra facts, handles, or names
- ends with a low-pressure prompt like "want me to make an intro?"

Return JSON: { "paragraph": "..." }`;

async function writeConnectorParagraph(memberProfile, request, candidates) {
  if (!candidates.length) return null;
  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 350,
      messages: [
        { role: "system", content: CONNECTOR_BLURB_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            member: {
              name: memberProfile.name,
              memberType: memberProfile.memberType,
              city: memberProfile.city,
              neighborhood: memberProfile.neighborhood,
            },
            request,
            candidates: candidates.map(c => ({
              name: c.profile?.name,
              memberType: c.profile?.memberType,
              category: c.profile?.businessCategory || c.profile?.category,
              vibe: c.profile?.vibe,
              description: c.profile?.businessDescription || c.profile?.approvedBlurb,
              neighborhood: c.profile?.neighborhood,
              city: c.profile?.city,
              matchedOn: c.matchedOn,
            })),
          }),
        },
      ],
      response_format: { type: "json_object" },
    });
    const parsed = JSON.parse(completion.choices[0].message.content);
    return parsed.paragraph || null;
  } catch (err) {
    console.error("writeConnectorParagraph error:", err);
    return null;
  }
}

// Connector-mode conversational search. Runs a real directory search for the
// member's natural-language request, writes a warm intro blurb (2nd LLM pass),
// and logs a matchLog per candidate so the self-improving loop keeps learning.
// Returns { paragraph, logs } or null when nothing was found.
export async function runConnectorSearch(memberId, memberProfile, searchQuery, { channel = "web", limit = 3 } = {}) {
  if (!searchQuery) return null;

  const { results } = await searchMembers({
    query: searchQuery,
    excludeIds: [memberId],
    limit,
    parseIntent: true,
  });

  const candidates = results.filter(r => r.id !== memberId).slice(0, limit);
  if (!candidates.length) return null;

  const paragraph = await writeConnectorParagraph(memberProfile, searchQuery, candidates);

  const logs = [];
  for (const c of candidates) {
    try {
      const id = await createMatchLog({
        memberId,
        memberName: memberProfile.name ?? null,
        matchedMemberId: c.id,
        matchedMemberName: c.profile?.name ?? null,
        reason: `connector search: "${searchQuery}"${c.matchedOn?.length ? ` · ${c.matchedOn.join(", ")}` : ""}`,
        channel,
      });
      logs.push({ id, matchedMemberId: c.id, name: c.profile?.name });
    } catch (err) {
      console.error("createMatchLog error:", err);
    }
  }

  return { paragraph, logs };
}

// Run a first-time recommendation round for a member.
// Prefers COMPLEMENTARY matches (their offers ↔ this member's needs); falls
// back to plain semantic similarity when there aren't enough complementary
// candidates (e.g. a sparse early network).
// Returns { paragraph, logs: [{id, matchedMemberId, name}] } or null.
export async function makeFirstRecommendations(memberId, memberProfile, { channel = "web", limit = 3 } = {}) {
  let candidates = [];
  try {
    candidates = await findComplementaryMatches(memberId, memberProfile, { limit });
  } catch (err) {
    console.error("findComplementaryMatches error:", err);
  }

  // Fall back to semantic similarity if complementary matching came up short.
  if (candidates.length < limit) {
    const query = buildQueryFromProfile(memberProfile);
    if (query) {
      try {
        const have = new Set([memberId, ...candidates.map(c => c.id)]);
        const { results } = await searchMembers({ query, excludeIds: [memberId], limit: limit + candidates.length, parseIntent: false });
        for (const r of results) {
          if (have.has(r.id)) continue;
          candidates.push(r);
          if (candidates.length >= limit) break;
        }
      } catch (err) {
        console.error("semantic fallback error:", err);
      }
    }
  }

  candidates = candidates.slice(0, limit);
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
