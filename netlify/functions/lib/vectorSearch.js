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

// Tolerate dirty data: some legacy profiles stored array fields as a bare
// string (or other). Coerce so a single malformed member can't crash a
// pool-wide scan (e.g. the convener's findPairings).
function asArray(v) {
  if (Array.isArray(v)) return v.filter(x => x != null);
  if (typeof v === "string" && v.trim()) return [v];
  return [];
}

// Text describing what a member can OFFER the community / a collaborator.
// Falls back to existing signals so members onboarded before needs/offers
// existed still get a meaningful offers vector.
export function buildOffersText(profile = {}) {
  const parts = [];
  if (asArray(profile.offers).length)           parts.push(asArray(profile.offers).join(", "));
  if (asArray(profile.services).length)         parts.push(`services: ${asArray(profile.services).join(", ")}`);
  if (asArray(profile.products).length)         parts.push(`products: ${asArray(profile.products).join(", ")}`);
  if (asArray(profile.shareTypes).length)       parts.push(asArray(profile.shareTypes).join(", "));
  if (profile.discipline)                       parts.push(profile.discipline);          // artists offer their craft
  if (asArray(profile.partnershipTypes).length) parts.push(asArray(profile.partnershipTypes).join(", ")); // influencers
  if (profile.businessDescription)              parts.push(profile.businessDescription);
  if (Array.isArray(profile.pricePerProduct) && profile.pricePerProduct.length) {
    const items = profile.pricePerProduct.filter(p => p?.name).map(p => p.name).join(", ");
    if (items) parts.push(items);
  }
  return parts.join(". ");
}

// Text describing what a member NEEDS from the community.
export function buildNeedsText(profile = {}) {
  const parts = [];
  if (asArray(profile.needs).length)            parts.push(asArray(profile.needs).join(", "));
  if (asArray(profile.goals).length)            parts.push(asArray(profile.goals).join(", "));
  if (asArray(profile.painPoints).length)       parts.push(asArray(profile.painPoints).join(", "));
  if (asArray(profile.needsMost).length)        parts.push(asArray(profile.needsMost).join(", "));
  if (asArray(profile.connectWith).length)      parts.push(`wants to connect with: ${asArray(profile.connectWith).join(", ")}`);
  if (asArray(profile.venueTypes).length)       parts.push(`looking for venues: ${asArray(profile.venueTypes).join(", ")}`); // artists need venues
  if (asArray(profile.interests).length)        parts.push(`interested in: ${asArray(profile.interests).join(", ")}`);        // shoppers seek these
  return parts.join(". ");
}

async function embedText(text) {
  const response = await getOpenAI().embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });
  return response.data[0].embedding;
}

// Light metadata for the needs/offers namespaces — enough to scope a
// complementary search (e.g. same city) without re-reading Firestore.
function buildCollabMetadata(profile) {
  const md = { memberType: profile.memberType || "unknown" };
  for (const k of ["city", "neighborhood"]) {
    if (profile[k]) md[k] = String(profile[k]).toLowerCase();
  }
  return md;
}

export async function upsertMemberVector(memberId, profile) {
  if (!process.env.PINECONE_API_KEY) return;
  const text = buildProfileText(profile);
  if (!text.trim()) return;

  const index = getIndex();
  await index.upsert([{
    id: memberId,
    values: await embedText(text),
    metadata: buildPineconeMetadata(profile),
  }]);

  // Complementary-matching vectors: a member's offers and needs live in their
  // own namespaces so we can search one against the other (A's needs → the
  // "offers" namespace finds members who offer what A needs, and vice versa).
  const collabMd = buildCollabMetadata(profile);
  const offersText = buildOffersText(profile);
  const needsText = buildNeedsText(profile);
  try {
    if (offersText.trim()) {
      await index.namespace("offers").upsert([{ id: memberId, values: await embedText(offersText), metadata: collabMd }]);
    }
    if (needsText.trim()) {
      await index.namespace("needs").upsert([{ id: memberId, values: await embedText(needsText), metadata: collabMd }]);
    }
  } catch (err) {
    console.error("upsert complementary vectors error:", err.message || err);
  }
}

// Bidirectional complementary search. Given a member's needs/offers text,
// returns ranked candidate ids who complement them. Each result carries the
// direction(s) it matched on so callers can explain the fit.
// `nsPrefix` selects the namespace set — "" for real data (offers/needs),
// "sim-" for the isolated sim environment (sim-offers/sim-needs).
export async function queryComplementary({ needsText, offersText, excludeIds = [], topK = 50, limit = 10, minScore = 0.2, nsPrefix = "" } = {}) {
  if (!process.env.PINECONE_API_KEY) return [];
  const index = getIndex();
  const exclude = new Set(excludeIds);
  const scores = new Map();

  const accumulate = (matches, direction) => {
    for (const m of matches || []) {
      if (exclude.has(m.id) || (m.score ?? 0) < minScore) continue;
      const cur = scores.get(m.id) || { id: m.id, score: 0, directions: [], memberType: m.metadata?.memberType };
      cur.score += m.score ?? 0;
      if (!cur.directions.includes(direction)) cur.directions.push(direction);
      scores.set(m.id, cur);
    }
  };

  if (needsText?.trim()) {
    const r = await index.namespace(`${nsPrefix}offers`).query({ vector: await embedText(needsText), topK, includeMetadata: true });
    accumulate(r.matches, "they_offer_what_you_need");
  }
  if (offersText?.trim()) {
    const r = await index.namespace(`${nsPrefix}needs`).query({ vector: await embedText(offersText), topK, includeMetadata: true });
    accumulate(r.matches, "they_need_what_you_offer");
  }

  return [...scores.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

// Embed a member's offers/needs into a prefixed namespace pair — used to seed
// the isolated sim environment (`sim-offers`/`sim-needs`) without touching the
// real complementary namespaces.
export async function upsertCollabVectorsToNamespace(memberId, profile, prefix = "") {
  if (!process.env.PINECONE_API_KEY) return;
  const index = getIndex();
  const md = buildCollabMetadata(profile);
  const offersText = buildOffersText(profile);
  const needsText = buildNeedsText(profile);
  if (offersText.trim()) await index.namespace(`${prefix}offers`).upsert([{ id: memberId, values: await embedText(offersText), metadata: md }]);
  if (needsText.trim()) await index.namespace(`${prefix}needs`).upsert([{ id: memberId, values: await embedText(needsText), metadata: md }]);
}

export async function clearNamespaces(names = []) {
  if (!process.env.PINECONE_API_KEY) return;
  const index = getIndex();
  for (const ns of names) {
    try { await index.namespace(ns).deleteAll(); } catch (e) { console.error("clearNamespace", ns, e.message); }
  }
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
  const index = getIndex();
  try { await index.deleteMany(ids); } catch (e) { console.error("deleteMemberVectors:", e.message); }
  for (const ns of ["offers", "needs"]) {
    try { await index.namespace(ns).deleteMany(ids); } catch (e) { console.error(`deleteMemberVectors ${ns}:`, e.message); }
  }
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
