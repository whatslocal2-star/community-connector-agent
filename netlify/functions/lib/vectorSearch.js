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
  if (profile.products?.length)         parts.push(`products: ${profile.products.join(", ")}`);
  if (profile.services?.length)         parts.push(`services: ${profile.services.join(", ")}`);
  if (Array.isArray(profile.pricePerProduct) && profile.pricePerProduct.length) {
    const items = profile.pricePerProduct
      .filter(p => p && p.name)
      .map(p => p.price != null ? `${p.name} $${p.price}` : p.name)
      .join(", ");
    if (items) parts.push(`menu: ${items}`);
  }
  if (profile.amenities?.length)        parts.push(`amenities: ${profile.amenities.join(", ")}`);
  if (profile.atmosphere?.length)       parts.push(`atmosphere: ${profile.atmosphere.join(", ")}`);
  if (profile.favoriteTeams?.length)    parts.push(`teams: ${profile.favoriteTeams.join(", ")}`);

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
    metadata: buildPineconeMetadata(profile),
  }]);
}

function buildPineconeMetadata(profile) {
  // Pinecone metadata supports string, number, boolean, and array<string>.
  // Anything we want to hard-filter on must live here.
  const md = {
    memberType: profile.memberType || "unknown",
    onboardingComplete: Boolean(profile.onboardingComplete),
  };

  const strFields = ["city", "neighborhood", "category", "subcategory", "discipline", "niche", "status"];
  for (const k of strFields) if (profile[k]) md[k] = String(profile[k]).toLowerCase();

  const numFields = ["priceMin", "priceMax", "latitude", "longitude"];
  for (const k of numFields) {
    const n = Number(profile[k]);
    if (Number.isFinite(n)) md[k] = n;
  }

  const boolFields = [
    "acceptsEBT", "acceptsCash", "acceptsCrypto",
    "wheelchairAccessible", "freeParking",
    "openLate", "open24Hours", "openWeekends",
    "veganOptions", "vegetarianOptions", "glutenFree", "halalCertified", "kosher", "byob", "fullBar",
    "sportsBar", "watchParties",
    "unclaimed",
  ];
  for (const k of boolFields) if (typeof profile[k] === "boolean") md[k] = profile[k];

  const arrFields = ["amenities", "atmosphere", "favoriteTeams"];
  for (const k of arrFields) {
    if (Array.isArray(profile[k]) && profile[k].length) {
      md[k] = profile[k].filter(v => typeof v === "string").map(v => v.toLowerCase());
    }
  }

  // Flatten pricePerProduct names for keyword filtering on product-level menus.
  if (Array.isArray(profile.pricePerProduct) && profile.pricePerProduct.length) {
    const names = profile.pricePerProduct
      .filter(p => p && p.name)
      .map(p => String(p.name).toLowerCase());
    if (names.length) md.productNames = names;
    const prices = profile.pricePerProduct
      .map(p => Number(p?.price))
      .filter(Number.isFinite);
    if (prices.length) {
      md.productPriceMin = Math.min(...prices);
      md.productPriceMax = Math.max(...prices);
    }
  }

  return md;
}

export async function deleteMemberVectors(ids) {
  if (!process.env.PINECONE_API_KEY || !ids?.length) return;
  try { await getIndex().deleteMany(ids); } catch (e) { console.error("deleteMemberVectors:", e.message); }
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
