import { getDb } from "./db.js";
import { FieldValue } from "firebase-admin/firestore";
import { createMatchLog } from "./matchLog.js";

// collabs/{id} — a Convener proposal the admin reviews and approves.
// {
//   type: "intro" | "group" | "event",   // 1 / 2 / 3
//   status: "flagged" | "approved" | "dismissed",
//   source: "auto" | "manual",           // scan-flagged vs admin-initiated
//   title, description,                   // null for intro; the event for group/event
//   adminSummary,                         // the "summary for me" piece
//   parties: [{
//     memberId, memberName, memberType,
//     role,                               // group/event role (null for intro)
//     message,                            // per-party relevancy message
//     score,
//     partyStatus: "proposed" | "in" | "out",  // admin toggles on parties' behalf
//   }],
//   rolesNeeded: [{ role, type, filled }],     // event template (type 3)
//   seedMemberId,                         // anchor (type 2)
//   createdAt, approvedAt,
//   matchLogIds: [],                      // edges written into the learning loop on approve
// }

const COLLAB_TYPES = ["intro", "group", "event"];

function sanitizeParties(parties = []) {
  return parties.map(p => ({
    memberId: p.memberId,
    memberName: p.memberName ?? null,
    memberType: p.memberType ?? null,
    role: p.role ?? null,
    message: p.message ?? null,
    score: typeof p.score === "number" ? p.score : null,
    partyStatus: p.partyStatus || "proposed",
  }));
}

export async function createCollab({
  type,
  source = "manual",
  title = null,
  description = null,
  adminSummary = null,
  parties = [],
  rolesNeeded = [],
  seedMemberId = null,
  status = "flagged",
}) {
  if (!COLLAB_TYPES.includes(type)) throw new Error(`invalid collab type: ${type}`);
  const db = getDb();
  const ref = db.collection("collabs").doc();
  await ref.set({
    type,
    status,
    source,
    title,
    description,
    adminSummary,
    parties: sanitizeParties(parties),
    rolesNeeded,
    seedMemberId,
    createdAt: FieldValue.serverTimestamp(),
    approvedAt: null,
    matchLogIds: [],
  });
  return ref.id;
}

export async function loadCollab(id) {
  const db = getDb();
  const doc = await db.collection("collabs").doc(id).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

// Review queue. Filters in-memory so no composite index is needed.
export async function listCollabs({ status, type, limit = 100 } = {}) {
  const db = getDb();
  const snap = await db.collection("collabs").limit(500).get();
  let out = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (status) out = out.filter(c => c.status === status);
  if (type) out = out.filter(c => c.type === type);
  out.sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
  return out.slice(0, limit);
}

// Anchor-centric edges: log each non-anchor party against the first party so
// the self-improving loop (loadSuccessfulMatches) keeps getting labeled
// examples once an outcome is recorded. For an intro this is the natural pair.
async function writeLearningEdges(collab, parties) {
  const inParties = parties.filter(p => p.partyStatus !== "out");
  if (inParties.length < 2) return [];
  const [anchor, ...rest] = inParties;
  const reason = collab.title
    ? `convener ${collab.type}: ${collab.title}`.slice(0, 300)
    : `convener ${collab.type}`.slice(0, 300);
  const ids = [];
  for (const p of rest) {
    try {
      const id = await createMatchLog({
        memberId: anchor.memberId,
        memberName: anchor.memberName,
        matchedMemberId: p.memberId,
        matchedMemberName: p.memberName,
        reason,
        channel: "web",
      });
      ids.push(id);
    } catch (err) {
      console.error("collab learning edge error:", err.message || err);
    }
  }
  return ids;
}

// Freeze the reviewed proposal: persist the admin's final party set + messages,
// mark approved, and seed the learning loop. Does NOT send anything (Phase 2).
export async function approveCollab(id, { parties, title, description, adminSummary } = {}) {
  const db = getDb();
  const ref = db.collection("collabs").doc(id);
  const existing = await loadCollab(id);
  if (!existing) return null;

  const finalParties = sanitizeParties(parties ?? existing.parties);
  const merged = {
    ...existing,
    title: title ?? existing.title,
    description: description ?? existing.description,
    adminSummary: adminSummary ?? existing.adminSummary,
    parties: finalParties,
  };
  const matchLogIds = await writeLearningEdges(merged, finalParties);

  await ref.update({
    status: "approved",
    approvedAt: FieldValue.serverTimestamp(),
    parties: finalParties,
    ...(title != null ? { title } : {}),
    ...(description != null ? { description } : {}),
    ...(adminSummary != null ? { adminSummary } : {}),
    matchLogIds,
  });
  return { id, status: "approved", matchLogIds };
}

export async function dismissCollab(id) {
  const db = getDb();
  await db.collection("collabs").doc(id).update({ status: "dismissed" });
  return { id, status: "dismissed" };
}

// Pair keys are order-independent so (A,B) and (B,A) dedupe to one collab.
export function pairKey(a, b) {
  return [a, b].sort().join("|");
}

// Keys for every party-pair in a collab — used to dedupe new proposals against
// what's already flagged/approved so the queue doesn't surface the same people.
export function collabPairKeys(collab) {
  const ids = (collab.parties || []).map(p => p.memberId).filter(Boolean);
  const keys = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) keys.push(pairKey(ids[i], ids[j]));
  }
  return keys;
}
