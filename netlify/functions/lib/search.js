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

function lc(v) { return typeof v === "string" ? v.toLowerCase() : v; }

function arrayIncludesAny(arr, needles) {
  if (!Array.isArray(arr)) return false;
  const lower = arr.map(lc);
  return needles.some(n => lower.includes(lc(n)));
}

function matchesFilters(profile, filters = {}, excludes = {}) {
  if (!profile) return false;
  for (const [k, v] of Object.entries(filters)) {
    if (v == null) continue;
    const pv = profile[k];
    if (k === "priceMax") {
      const pmax = Number(profile.priceMax ?? profile.priceCeiling);
      if (Number.isFinite(pmax) && pmax > v) return false;
    } else if (k === "priceMin") {
      const pmin = Number(profile.priceMin ?? profile.priceFloor);
      if (Number.isFinite(pmin) && pmin < v) return false;
    } else if (k === "amenities") {
      if (!arrayIncludesAny(profile.amenities, v)) return false;
    } else if (typeof v === "boolean") {
      if (Boolean(pv) !== v) return false;
    } else if (typeof v === "string") {
      if (!pv || !String(pv).toLowerCase().includes(v.toLowerCase())) return false;
    }
  }
  for (const [k, v] of Object.entries(excludes)) {
    if (v == null) continue;
    if (k === "amenities") {
      if (arrayIncludesAny(profile.amenities, v)) return false;
    } else if (typeof v === "string") {
      const pv = profile[k];
      if (pv && String(pv).toLowerCase().includes(v.toLowerCase())) return false;
    }
  }
  return true;
}

async function embedQuery(text) {
  const res = await getOpenAI().embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });
  return res.data[0].embedding;
}

// One unified search function. Used by the public search bar and (later)
// by the chat agent. Hard filters first, then semantic ranking.
export async function searchMembers({ query, filters = {}, excludes = {}, excludeIds = [], limit = 20, topK = 80, parseIntent = true } = {}) {
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

  // Pinecone metadata only stores memberType + onboardingComplete today,
  // so filter at the metadata level when we can and apply the rest in-memory.
  const pineconeFilter = {};
  if (intent.filters.memberType) pineconeFilter.memberType = intent.filters.memberType;

  let pineconeMatches = [];
  if (intent.semantic && process.env.PINECONE_API_KEY) {
    const vector = await embedQuery(intent.semantic);
    const result = await getIndex().query({
      vector,
      topK,
      includeMetadata: true,
      ...(Object.keys(pineconeFilter).length ? { filter: pineconeFilter } : {}),
    });
    pineconeMatches = result.matches || [];
  }

  // Load matching member docs, then apply hard filters in-memory.
  const db = getDb();
  let candidates = [];

  if (pineconeMatches.length) {
    const docs = await Promise.all(
      pineconeMatches.map(async m => {
        const snap = await db.collection("members").doc(m.id).get();
        if (!snap.exists) return null;
        const { history, ...rest } = snap.data();
        return { id: snap.id, score: m.score, ...rest };
      })
    );
    candidates = docs.filter(Boolean);
  } else {
    // Pure-filter search (no semantic query) — scan a recent slice.
    const snap = await db.collection("members").orderBy("lastActiveAt", "desc").limit(500).get();
    candidates = snap.docs.map(d => {
      const { history, ...rest } = d.data();
      return { id: d.id, score: 0, ...rest };
    });
  }

  const excludeSet = new Set(excludeIds);
  const filtered = candidates
    .filter(m => !excludeSet.has(m.id))
    .filter(m => matchesFilters(m.profile, intent.filters, intent.excludes))
    .map(sanitize)
    .slice(0, limit);

  return { intent, results: filtered };
}

function sanitize(member) {
  const { profile = {}, ...rest } = member;
  const { phone, ...safeProfile } = profile;
  return { ...rest, profile: safeProfile };
}
