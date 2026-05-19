import { Pinecone } from "@pinecone-database/pinecone";
import OpenAI from "openai";
import { getDb } from "./db.js";
import { parseSearchIntent } from "./searchIntent.js";

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

// Hard filter keys — go into Pinecone metadata. Reliable / well-populated on imports.
const STR_HARD_KEYS = ["category", "subcategory", "discipline", "niche"];
// Soft filter keys — applied in-memory; missing on profile = pass-through ("no opinion").
const STR_SOFT_KEYS = ["city", "neighborhood"];
const STR_FILTER_KEYS = [...STR_HARD_KEYS, ...STR_SOFT_KEYS];
const BOOL_FILTER_KEYS = [
  "acceptsEBT", "acceptsCash", "acceptsCrypto",
  "wheelchairAccessible", "freeParking",
  "openLate", "open24Hours", "openWeekends",
  "veganOptions", "vegetarianOptions", "glutenFree", "halalCertified", "kosher", "byob", "fullBar",
  "sportsBar", "watchParties",
];
const ARRAY_FILTER_KEYS = ["amenities", "atmosphere", "favoriteTeams"];

function lc(v) { return typeof v === "string" ? v.toLowerCase() : v; }

// Common city aliases — normalize before substring match.
const CITY_ALIASES = {
  "sf": "san francisco",
  "s.f.": "san francisco",
  "the city": "san francisco",
  "oak": "oakland",
  "the town": "oakland",
  "nyc": "new york",
  "la": "los angeles",
};
function expandCity(v) { return CITY_ALIASES[lc(v)] || v; }

// Build a Pinecone metadata filter from intent.filters / intent.excludes.
// Anything not expressible here falls through to in-memory matching.
export function buildPineconeFilter(filters = {}, excludes = {}) {
  const f = {};
  if (filters.memberType) f.memberType = filters.memberType;
  for (const k of STR_HARD_KEYS) {
    if (filters[k]) f[k] = lc(filters[k]);
  }
  // STR_SOFT_KEYS intentionally NOT pushed to Pinecone — applied in-memory so
  // records with no city/neighborhood don't get excluded before ranking.
  for (const k of BOOL_FILTER_KEYS) {
    if (typeof filters[k] === "boolean") f[k] = filters[k];
  }
  for (const k of ARRAY_FILTER_KEYS) {
    if (Array.isArray(filters[k]) && filters[k].length) {
      f[k] = { $in: filters[k].map(lc) };
    }
  }
  if (Number.isFinite(filters.priceMax)) f.priceMin = { $lte: filters.priceMax };
  if (Number.isFinite(filters.priceMin)) f.priceMax = { $gte: filters.priceMin };

  // Excludes — Pinecone supports $nin for arrays and $ne for scalars
  for (const k of ARRAY_FILTER_KEYS) {
    if (Array.isArray(excludes[k]) && excludes[k].length) {
      f[k] = Object.assign(f[k] || {}, { $nin: excludes[k].map(lc) });
    }
  }

  return f;
}

// Product-level price match: business must have a pricePerProduct entry whose
// name semantically matches the query product AND price ≤ priceMax.
export function productMatches(profile, productName, priceMax) {
  if (!productName) return null; // no opinion
  const list = Array.isArray(profile.pricePerProduct) ? profile.pricePerProduct : [];
  if (!list.length) return null; // no opinion when business hasn't listed menu
  const needle = String(productName).toLowerCase();
  const tokens = needle.split(/\s+/).filter(Boolean);
  const hit = list.find(p => {
    if (!p?.name) return false;
    const name = String(p.name).toLowerCase();
    const nameMatches = name.includes(needle) || tokens.every(t => name.includes(t));
    if (!nameMatches) return false;
    if (priceMax != null && Number.isFinite(Number(p.price))) {
      return Number(p.price) <= priceMax;
    }
    return true;
  });
  return hit || false;
}

export function matchesFilters(profile, filters = {}, excludes = {}) {
  if (!profile) return { ok: false, matched: [] };
  const matched = [];

  for (const [k, v] of Object.entries(filters)) {
    if (v == null) continue;
    if (k === "memberType" || k === "product") continue;

    if (k === "priceMax") {
      const pmax = Number(profile.priceMax ?? profile.priceCeiling ?? profile.productPriceMax);
      if (Number.isFinite(pmax) && pmax > v) {
        // Member-level ceiling is above query cap. If we have a per-product
        // hit at or under v, accept; otherwise reject.
        const prod = productMatches(profile, filters.product, v);
        if (prod === false) return { ok: false, matched: [] };
        if (prod) matched.push(`${prod.name} $${prod.price} ≤ $${v}`);
        else matched.push(`under $${v}`);
      } else if (Number.isFinite(pmax)) {
        matched.push(`under $${v}`);
      }
    } else if (k === "priceMin") {
      const pmin = Number(profile.priceMin ?? profile.priceFloor);
      if (Number.isFinite(pmin) && pmin < v) return { ok: false, matched: [] };
      matched.push(`from $${v}`);
    } else if (ARRAY_FILTER_KEYS.includes(k)) {
      const arr = Array.isArray(profile[k]) ? profile[k].map(lc) : [];
      const needles = Array.isArray(v) ? v.map(lc) : [lc(v)];
      const hits = needles.filter(n => arr.includes(n));
      if (!hits.length) return { ok: false, matched: [] };
      hits.forEach(h => matched.push(`${h} ✓`));
    } else if (BOOL_FILTER_KEYS.includes(k)) {
      if (Boolean(profile[k]) !== Boolean(v)) return { ok: false, matched: [] };
      if (v) matched.push(humanize(k));
    } else if (typeof v === "string") {
      const pv = profile[k];
      const isSoft = STR_SOFT_KEYS.includes(k);
      if (!pv) {
        // Soft fields with no value on profile: don't reject, don't badge.
        // Hard fields with no value: reject as before.
        if (!isSoft) return { ok: false, matched: [] };
      } else if (!String(pv).toLowerCase().includes(String(k === "city" ? expandCity(v) : v).toLowerCase())) {
        // Field is present but doesn't match the query value: always reject.
        return { ok: false, matched: [] };
      } else {
        matched.push(`${humanize(k)}: ${v}`);
      }
    }
  }

  // Standalone product filter (no priceMax) — still must offer it if business has a menu
  if (filters.product && filters.priceMax == null) {
    const prod = productMatches(profile, filters.product, null);
    if (prod === false) return { ok: false, matched: [] };
    if (prod) matched.push(`offers ${prod.name}`);
  }

  for (const [k, v] of Object.entries(excludes)) {
    if (v == null) continue;
    if (ARRAY_FILTER_KEYS.includes(k)) {
      const arr = Array.isArray(profile[k]) ? profile[k].map(lc) : [];
      const needles = Array.isArray(v) ? v.map(lc) : [lc(v)];
      if (needles.some(n => arr.includes(n))) return { ok: false, matched: [] };
    } else if (typeof v === "string") {
      const pv = profile[k];
      if (pv && String(pv).toLowerCase().includes(v.toLowerCase())) return { ok: false, matched: [] };
    }
  }

  return { ok: true, matched };
}

function humanize(key) {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, c => c.toLowerCase()).trim();
}

async function embedQuery(text) {
  const res = await getOpenAI().embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });
  return res.data[0].embedding;
}

export async function searchMembers({ query, filters = {}, excludes = {}, excludeIds = [], limit = 20, topK = 200, parseIntent = true, minScore = 0.25 } = {}) {
  if (!query && Object.keys(filters).length === 0) {
    return { intent: { semantic: "", filters, excludes, intent: "find" }, results: [] };
  }

  let intent = { semantic: query || "", filters, excludes, intent: "find" };
  if (query && parseIntent) {
    const parsed = await parseSearchIntent(query);
    intent = {
      semantic: parsed.semantic,
      filters: { ...parsed.filters, ...filters },
      excludes: { ...parsed.excludes, ...excludes },
      intent: parsed.intent,
    };
  }

  // Push as many filters as we can into Pinecone metadata so hard-filtering
  // happens at the vector-DB level, not after a topK cutoff in memory.
  const pineconeFilter = buildPineconeFilter(intent.filters, intent.excludes);

  let pineconeMatches = [];
  if (intent.semantic && process.env.PINECONE_API_KEY) {
    const vector = await embedQuery(intent.semantic);
    const result = await getIndex().query({
      vector,
      topK,
      includeMetadata: true,
      ...(Object.keys(pineconeFilter).length ? { filter: pineconeFilter } : {}),
    });
    pineconeMatches = (result.matches || []).filter(m => (m.score ?? 0) >= minScore);
  }

  const db = getDb();
  let candidates = [];

  if (pineconeMatches.length) {
    // Batch into one Firestore RPC instead of N parallel reads.
    // Sequential RPCs would blow the 10s function budget at topK=200;
    // even parallel reads pay per-RPC connection overhead and pressure
    // Firestore's per-instance request cap.
    const refs = pineconeMatches.map(m => db.collection("members").doc(m.id));
    const snaps = await db.getAll(...refs);
    const scoreById = new Map(pineconeMatches.map(m => [m.id, m.score]));
    candidates = snaps
      .filter(s => s.exists)
      .map(s => {
        const { history, ...rest } = s.data();
        return { id: s.id, score: scoreById.get(s.id) ?? 0, ...rest };
      });
  } else {
    const snap = await db.collection("members").orderBy("lastActiveAt", "desc").limit(500).get();
    candidates = snap.docs.map(d => {
      const { history, ...rest } = d.data();
      return { id: d.id, score: 0, ...rest };
    });
  }

  const excludeSet = new Set(excludeIds);
  const filtered = [];
  for (const m of candidates) {
    if (excludeSet.has(m.id)) continue;
    const { ok, matched } = matchesFilters(m.profile, intent.filters, intent.excludes);
    if (!ok) continue;
    filtered.push({ ...sanitize(m), matchedOn: matched });
    if (filtered.length >= limit) break;
  }

  return { intent, results: filtered };
}

function sanitize(member) {
  const { profile = {}, ...rest } = member;
  const { phone, ...safeProfile } = profile;
  return { ...rest, profile: safeProfile };
}
