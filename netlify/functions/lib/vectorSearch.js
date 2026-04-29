import { Pinecone } from "@pinecone-database/pinecone";
import OpenAI from "openai";

let _pc = null;
let _openai = null;

function getPinecone() {
  if (!_pc) _pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  return _pc;
}

function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

function getIndex() {
  return getPinecone().index(process.env.PINECONE_INDEX_NAME || "community-members");
}

function buildProfileText(profile) {
  const parts = [];

  // Vendor — frame as what they offer
  if (profile.businessDescription)      parts.push(profile.businessDescription);
  if (profile.approvedBlurb)            parts.push(profile.approvedBlurb);
  if (profile.shareTypes?.length)       parts.push(`offers: ${profile.shareTypes.join(", ")}`);

  // Shopper — frame as what they seek (same semantic space as vendor offerings)
  if (profile.interests?.length)        parts.push(profile.interests.join(", "));
  if (profile.personalNote)             parts.push(profile.personalNote);
  if (profile.connectionPreference)     parts.push(profile.connectionPreference);

  // Artist
  if (profile.discipline)               parts.push(profile.discipline);
  if (profile.venueTypes?.length)       parts.push(profile.venueTypes.join(", "));

  // Organizer
  if (profile.cause)                    parts.push(profile.cause);
  if (profile.impactGoals?.length)      parts.push(profile.impactGoals.join(", "));
  if (profile.connectWith?.length)      parts.push(profile.connectWith.join(", "));

  // Influencer
  if (profile.niche)                    parts.push(profile.niche);
  if (profile.partnershipTypes?.length) parts.push(profile.partnershipTypes.join(", "));
  if (profile.platforms?.length)        parts.push(profile.platforms.join(", "));

  // Shared signals — location and vibe anchor geographic + personality matches
  if (profile.neighborhood)             parts.push(profile.neighborhood);
  if (profile.city)                     parts.push(profile.city);
  if (profile.location)                 parts.push(profile.location);
  if (profile.vibe)                     parts.push(profile.vibe);
  if (profile.goals?.length)            parts.push(profile.goals.join(", "));
  if (profile.painPoints?.length)       parts.push(profile.painPoints.join(", "));
  if (profile.notes?.length)            parts.push(profile.notes.join(", "));

  return parts.join(". ");
}

export async function upsertMemberVector(memberId, profile) {
  if (!process.env.PINECONE_API_KEY) return;
  const text = buildProfileText(profile);
  if (!text.trim()) return;

  const response = await getOpenAI().embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });

  await getIndex().upsert([{
    id: memberId,
    values: response.data[0].embedding,
    metadata: {
      memberType: profile.memberType || "unknown",
      onboardingComplete: Boolean(profile.onboardingComplete),
    },
  }]);
}

export async function findSimilarMembers(memberId, topK = 5) {
  const index = getIndex();

  const fetched = await index.fetch([memberId]);
  const record = fetched.records?.[memberId];
  if (!record?.values) return [];

  const result = await index.query({
    vector: record.values,
    topK: topK + 1,
    includeMetadata: true,
  });

  return result.matches
    .filter(m => m.id !== memberId)
    .slice(0, topK)
    .map(m => ({ id: m.id, score: m.score, memberType: m.metadata?.memberType }));
}
