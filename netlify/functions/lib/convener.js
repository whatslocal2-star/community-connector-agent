import OpenAI from "openai";
import { getDb } from "./db.js";
import { queryComplementary, buildNeedsText, buildOffersText, findSimilarMembers } from "./vectorSearch.js";
import { pairKey } from "./collabs.js";
import { topAffinityLineup } from "./matchFormats.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MATCH_POOL_LIMIT = 300;
const CROSS_TYPE_BOOST = 1.15; // cross-type fits are preferred, not required

// Pure: boost cross-type fits without making them mandatory.
export function rankPairScore(rawScore, crossType) {
  return Number(((rawScore ?? 0) * (crossType ? CROSS_TYPE_BOOST : 1)).toFixed(3));
}

// Pure: guarantee exactly one message per member, filling any the model
// dropped from the deterministic fallback. Keeps writeMessages output stable.
export function reconcileMessages(contexts, parsed, fallback) {
  const fb = fallback();
  const byId = new Map((parsed?.parties || []).map(p => [p.memberId, p.message]));
  return {
    adminSummary: parsed?.adminSummary || fb.adminSummary,
    parties: contexts.map(c => ({
      memberId: c.memberId,
      message: byId.get(c.memberId) || fb.parties.find(f => f.memberId === c.memberId)?.message || null,
    })),
  };
}

const DIRECTION_LABEL = {
  they_offer_what_you_need: "offers what the other needs",
  they_need_what_you_offer: "needs what the other offers",
};

// Default role label for a member type when forming a group/event lineup.
const ROLE_FOR_TYPE = {
  vendor: "vendor / food",
  artist: "artist",
  organizer: "community org / venue",
  influencer: "promotion / reach",
  shopper: "community member",
};

// Environments. "real" = live data; "sim" = the isolated test environment
// (separate Firestore collection + Pinecone namespaces). Real flows never read
// the sim collection or namespaces, so there's no interference by construction.
const ENVS = {
  real: { collection: "members", nsPrefix: "" },
  sim: { collection: "sim_members", nsPrefix: "sim-" },
};
export const resolveEnv = (env) => ENVS[env] || ENVS.real;

// All members with a profile. No orderBy so unclaimed/harvested members
// (which may lack lastActiveAt) are included in the matching pool.
export async function loadMatchPool(collection = "members", limit = MATCH_POOL_LIMIT) {
  const db = getDb();
  const snap = await db.collection(collection).limit(limit).get();
  return snap.docs
    .map(d => {
      const { history, ...rest } = d.data();
      return { id: d.id, ...rest };
    })
    .filter(m =>
      m.profile &&
      // Shoppers are consumers, not collaborators — they're matched TO vendors
      // via recommendations, never surfaced as a collab party.
      m.profile.memberType !== "shopper" &&
      // Members pruned from the pool (inactive / persistent decliners) are not
      // surfaced as candidates or used as anchors.
      m.collabActivity?.poolStatus !== "removed");
}

function poolIndex(pool) {
  return new Map(pool.map(m => [m.id, m]));
}

// Compact profile snapshot shown when the admin hovers a party in review —
// the "why" behind a match (offers/needs drive complementary fit). Stored on
// the party so both draft and saved-collab cards can render it without refetch.
function partyDetail(member) {
  const p = member.profile || {};
  return {
    neighborhood: p.neighborhood || null,
    city: p.city || null,
    vibe: p.vibe || null,
    offers: Array.isArray(p.offers) ? p.offers : [],
    needs: Array.isArray(p.needs) ? p.needs : [],
    description: p.businessDescription || p.approvedBlurb || null,
  };
}

// Compact view of a member for the message-writing prompt. Phone never leaks.
function partyContext(member, { role = null, score = null } = {}) {
  const p = member.profile || {};
  return {
    memberId: member.id,
    name: p.name || null,
    memberType: p.memberType || null,
    role,
    score,
    category: p.businessCategory || p.category || null,
    neighborhood: p.neighborhood || null,
    city: p.city || null,
    vibe: p.vibe || null,
    offers: p.offers || null,
    needs: p.needs || null,
    description: p.businessDescription || p.approvedBlurb || null,
    status: member.status || null,
  };
}

const MESSAGE_PROMPT = `You are the Convener for a local community marketplace — you spot collaborations between members and brief a human admin who will review them.

You are given a proposed collaboration (an intro between two members, or a group collab / event) and the members involved with their real profile facts. Write, as strict JSON:
{
  "adminSummary": "1-2 sentences for the ADMIN explaining why this match is worth surfacing and what could come of it",
  "parties": [
    { "memberId": "<id>", "message": "a warm 1-2 sentence note addressed to THIS member explaining why this collaboration is relevant to THEM specifically" }
  ]
}

Rules:
- Use ONLY the facts provided. Never invent names, handles, offerings, or details.
- Each party message speaks directly to that member ("you"), grounded in what they offer/need and what the others bring.
- For a group/event, weave in each member's role and what they'd contribute.
- Warm and concrete, like a plugged-in friend — not a directory listing. No emojis.
- Return one entry in "parties" for every member given, keyed by their exact memberId.`;

// Single grounded LLM pass producing the admin summary + one per-party message.
// Falls back to deterministic text if the model is unavailable so a draft is
// always reviewable.
export async function writeMessages(members, { type = "intro", title = null, description = null, roles = {} } = {}) {
  const contexts = members.map(m => partyContext(m, { role: roles[m.id] ?? null }));
  const fallback = () => ({
    adminSummary: title
      ? `Possible ${type}: "${title}" with ${contexts.map(c => c.name || c.memberId).join(", ")}.`
      : `Possible ${type} between ${contexts.map(c => c.name || c.memberId).join(" and ")}.`,
    parties: contexts.map(c => ({
      memberId: c.memberId,
      message: `We think a collaboration with ${contexts.filter(o => o.memberId !== c.memberId).map(o => o.name || "another member").join(", ")} could be a great fit for you.`,
    })),
  });

  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 600,
      messages: [
        { role: "system", content: MESSAGE_PROMPT },
        { role: "user", content: JSON.stringify({ type, title, description, members: contexts }) },
      ],
      response_format: { type: "json_object" },
    });
    const parsed = JSON.parse(completion.choices[0].message.content);
    if (!parsed?.parties?.length) return fallback();
    return reconcileMessages(contexts, parsed, fallback);
  } catch (err) {
    console.error("writeMessages error:", err.message || err);
    return fallback();
  }
}

// ── Type 1: pairwise intros ────────────────────────────────────────────────
// Cheap ranked pair candidates (no LLM). For each member, find its single best
// complementary counterpart, dedupe symmetric pairs, boost cross-type fits.
export async function findPairings({ limit = 12, excludePairKeys = [], pool = null, env = "real" } = {}) {
  const { collection, nsPrefix } = resolveEnv(env);
  pool = pool || await loadMatchPool(collection);
  const idx = poolIndex(pool);
  const seen = new Set(excludePairKeys);
  const pairs = [];
  const target = limit * 2; // collect a few extra, then rank

  const addPair = (a, b, score, fit, basis) => {
    const key = pairKey(a.id, b.id);
    if (seen.has(key)) return false;
    seen.add(key);
    const ta = a.profile.memberType;
    const tb = b.profile.memberType;
    const crossType = ta && tb && ta !== tb;
    pairs.push({
      members: [a.id, b.id],
      memberTypes: [ta || null, tb || null],
      rawScore: Number(score?.toFixed?.(3) ?? score ?? 0),
      score: rankPairScore(score, crossType),
      crossType: !!crossType,
      basis,
      fit,
    });
    return true;
  };

  // Find one counterpart for a member — complementary first, then semantic
  // similarity. Pure read (no shared state) so a batch can run concurrently.
  const findCounterpart = async (m) => {
    const needsText = buildNeedsText(m.profile);
    const offersText = buildOffersText(m.profile);
    if (needsText.trim() || offersText.trim()) {
      const ranked = await queryComplementary({ needsText, offersText, excludeIds: [m.id], limit: 5, nsPrefix });
      for (const r of ranked) {
        const other = idx.get(r.id);
        if (other) return { m, other, score: r.score, fit: (r.directions || []).map(d => DIRECTION_LABEL[d] || d), basis: "complementary" };
      }
    }
    try {
      const similar = await findSimilarMembers(m.id, 5);
      for (const s of similar) {
        const other = idx.get(s.id);
        if (other) return { m, other, score: s.score, fit: ["similar profile"], basis: "semantic" };
      }
    } catch { /* member not in the index yet — skip */ }
    return null;
  };

  // Scan in concurrent batches so the per-member embed+query calls overlap.
  // Each is independent; we dedupe + rank after. Stop once we have enough.
  const BATCH = 10;
  for (let i = 0; i < pool.length && pairs.length < target; i += BATCH) {
    const found = await Promise.all(pool.slice(i, i + BATCH).map(findCounterpart));
    for (const f of found) {
      if (f) addPair(f.m, f.other, f.score, f.fit, f.basis);
    }
  }

  pairs.sort((a, b) => b.score - a.score);
  return pairs.slice(0, limit);
}

// Hydrate a pair candidate into a full (unsaved) intro collab draft, including
// the admin summary + per-party messages. One LLM call.
export async function composePairing(pair, { pool = null } = {}) {
  pool = pool || await loadMatchPool();
  const idx = poolIndex(pool);
  const members = pair.members.map(id => idx.get(id)).filter(Boolean);
  if (members.length < 2) return null;

  const msgs = await writeMessages(members, { type: "intro" });
  const byId = new Map(msgs.parties.map(p => [p.memberId, p.message]));
  return {
    type: "intro",
    title: null,
    description: null,
    adminSummary: msgs.adminSummary,
    basis: pair.basis || null,   // "complementary" | "semantic" — why we paired them
    fit: pair.fit || [],         // direction labels, or ["similar profile"]
    parties: members.map(m => ({
      memberId: m.id,
      memberName: m.profile.name || null,
      memberType: m.profile.memberType || null,
      role: null,
      message: byId.get(m.id) || null,
      score: pair.score,
      partyStatus: "proposed",
      detail: partyDetail(m),
    })),
  };
}

// Orchestrator for the "Find pairings" action and the scan cron: load the pool
// once, rank pairs, and compose the top `compose` into full drafts with
// messages. Cheaper than calling findPairings + composePairing separately.
export async function proposePairings({ limit = 12, compose = 6, excludePairKeys = [], env = "real" } = {}) {
  const { collection } = resolveEnv(env);
  const pool = await loadMatchPool(collection);
  const pairs = await findPairings({ limit, excludePairKeys, pool, env });
  // Compose the top pairs concurrently — each is one independent LLM call.
  const drafts = await Promise.all(pairs.slice(0, compose).map(pair => composePairing(pair, { pool })));
  return drafts.filter(Boolean);
}

// ── Type 2: group collabs ──────────────────────────────────────────────────
// Build a lineup of complementary members. Anchor-driven when seedMemberId is
// given; otherwise seeds from the strongest available member. An explicit
// `lineup` (member types) clones a learned format; absent that, the anchor's
// own format affinity shapes the lineup, falling back to a diverse mix.
export async function buildGroup({ seedMemberId = null, size = 3, lineup = null, pool = null, env = "real" } = {}) {
  const { collection, nsPrefix } = resolveEnv(env);
  pool = pool || await loadMatchPool(collection);
  const idx = poolIndex(pool);

  let anchor = seedMemberId ? idx.get(seedMemberId) : null;
  if (!anchor) {
    // Autonomous: richest needs+offers signal. When a target lineup is given,
    // anchor on someone whose type the lineup actually calls for.
    const eligible = lineup?.length ? pool.filter(m => lineup.includes(m.profile.memberType)) : pool;
    anchor = (eligible.length ? eligible : pool)
      .map(m => ({ m, signal: (buildNeedsText(m.profile) + buildOffersText(m.profile)).length }))
      .sort((a, b) => b.signal - a.signal)[0]?.m;
  }
  if (!anchor) return null;

  // No explicit lineup → lean on what this anchor has said yes to before.
  let lineupTypes = lineup;
  if (!lineupTypes) lineupTypes = topAffinityLineup(anchor.collabActivity?.formatAffinity);

  const chosen = [anchor];
  const usedTypes = new Set([anchor.profile.memberType].filter(Boolean));
  const usedIds = new Set([anchor.id]);

  // Types the lineup still needs after seating the anchor (null = diverse mode).
  let needTypes = null;
  if (lineupTypes?.length) {
    needTypes = [...lineupTypes];
    const ai = needTypes.indexOf(anchor.profile.memberType);
    if (ai >= 0) needTypes.splice(ai, 1);
    size = lineupTypes.length;
  }

  const needsText = buildNeedsText(anchor.profile);
  const offersText = buildOffersText(anchor.profile);
  const ranked = await queryComplementary({ needsText, offersText, excludeIds: [anchor.id], limit: 25, nsPrefix });
  for (const r of ranked) {
    if (chosen.length >= size) break;
    const cand = idx.get(r.id);
    if (!cand || usedIds.has(cand.id)) continue;
    const t = cand.profile.memberType;
    if (needTypes) {
      const ti = needTypes.indexOf(t);
      if (ti < 0) continue;        // not a role this lineup still needs
      needTypes.splice(ti, 1);
    } else {
      if (t && usedTypes.has(t)) continue; // prefer a diverse lineup
      if (t) usedTypes.add(t);
    }
    chosen.push(cand);
    usedIds.add(cand.id);
  }

  if (chosen.length < 2) return null;

  const roles = {};
  for (const m of chosen) roles[m.id] = ROLE_FOR_TYPE[m.profile.memberType] || "collaborator";

  const msgs = await writeMessages(chosen, { type: "group", roles });
  const byId = new Map(msgs.parties.map(p => [p.memberId, p.message]));
  return {
    type: "group",
    title: null,
    description: null,
    adminSummary: msgs.adminSummary,
    seedMemberId: anchor.id,
    basis: "complementary",
    fit: [],
    parties: chosen.map(m => ({
      memberId: m.id,
      memberName: m.profile.name || null,
      memberType: m.profile.memberType || null,
      role: roles[m.id],
      message: byId.get(m.id) || null,
      score: null,
      partyStatus: "proposed",
      detail: partyDetail(m),
    })),
  };
}

// Replace flow: ranked candidates that fit a role, excluding members already in
// the collab. roleType (optional) hard-filters to a member type. Returns a
// selectable list (no messages — messages are written on approve).
export async function nextBestForRole({ needsText, roleType = null, excludeIds = [], limit = 8, pool = null, env = "real" } = {}) {
  const { collection, nsPrefix } = resolveEnv(env);
  pool = pool || await loadMatchPool(collection);
  const idx = poolIndex(pool);
  const ranked = await queryComplementary({ needsText: needsText || "", excludeIds, limit: limit * 3, nsPrefix });
  const out = [];
  for (const r of ranked) {
    const m = idx.get(r.id);
    if (!m) continue;
    if (roleType && m.profile.memberType !== roleType) continue;
    out.push({
      memberId: m.id,
      memberName: m.profile.name || null,
      memberType: m.profile.memberType || null,
      score: Number(r.score?.toFixed?.(3) ?? r.score ?? 0),
      offers: (m.profile.offers || []).slice(0, 3),
      neighborhood: m.profile.neighborhood || null,
      city: m.profile.city || null,
      status: m.status || null,
      detail: partyDetail(m),
    });
    if (out.length >= limit) break;
  }
  return out;
}

// ── Type 3: event-first collabs ────────────────────────────────────────────
const EVENT_PROMPT = `You are the Convener for a local community marketplace. Given a snapshot of the kinds of members currently available (types + what they offer) and an optional admin hint, invent ONE concrete, locally grounded event or collaboration that these members could pull off together.

Return strict JSON:
{
  "title": "short event name",
  "description": "2-3 sentences describing the event and why it fits this community",
  "rolesNeeded": [ { "role": "human-readable role", "type": "vendor|artist|organizer|influencer" } ]
}

Rules:
- Propose 2-4 roles, drawn from member types that actually appear in the snapshot.
- Be specific and realistic; do not invent member names. No emojis.`;

export async function inventEvent({ hint = null, sampleSize = 40, env = "real" } = {}) {
  const { collection } = resolveEnv(env);
  const pool = await loadMatchPool(collection);
  // Compact landscape: member types + a few offer phrases each, bounded.
  const sample = pool.slice(0, sampleSize).map(m => ({
    type: m.profile.memberType || "unknown",
    offers: (m.profile.offers || []).slice(0, 2),
    category: m.profile.businessCategory || m.profile.category || null,
    neighborhood: m.profile.neighborhood || null,
  }));

  let event;
  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 500,
      messages: [
        { role: "system", content: EVENT_PROMPT },
        { role: "user", content: JSON.stringify({ hint, landscape: sample }) },
      ],
      response_format: { type: "json_object" },
    });
    event = JSON.parse(completion.choices[0].message.content);
  } catch (err) {
    console.error("inventEvent error:", err.message || err);
    return null;
  }
  if (!event?.title || !Array.isArray(event.rolesNeeded)) return null;

  // Fill each role with a ranked, selectable candidate list.
  const needsBase = `${event.title}. ${event.description || ""}`.trim();
  const filled = [];
  for (const r of event.rolesNeeded) {
    const candidates = await nextBestForRole({
      needsText: `${needsBase} role: ${r.role}`,
      roleType: r.type || null,
      excludeIds: [],
      limit: 8,
      pool,
      env,
    });
    filled.push({ role: r.role, type: r.type || null, candidates });
  }

  return {
    type: "event",
    title: event.title,
    description: event.description || null,
    rolesNeeded: event.rolesNeeded.map(r => ({ role: r.role, type: r.type || null, filled: false })),
    roleCandidates: filled,
    parties: [],
  };
}
