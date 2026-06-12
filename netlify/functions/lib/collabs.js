import { getDb } from "./db.js";
import { FieldValue } from "firebase-admin/firestore";
import { createMatchLog } from "./matchLog.js";
import { recordProposed, recordResponse } from "./collabActivity.js";

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
    invitedAt: p.invitedAt ?? null,
    response: p.response ?? null, // { decision, note, respondedAt } once they reply
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

// Attach a collab to each in-party's member doc so the connector agent can
// surface it as a pending option in the member's existing chat thread.
async function attachPendingToMembers(collabId, memberIds) {
  if (!memberIds.length) return;
  const db = getDb();
  const batch = db.batch();
  for (const mid of memberIds) {
    batch.set(
      db.collection("members").doc(mid),
      { pendingCollabs: FieldValue.arrayUnion(collabId) },
      { merge: true },
    );
  }
  await batch.commit();
}

// Freeze the reviewed proposal: persist the admin's final party set + messages,
// mark approved, seed the learning loop, and deliver the option in-app by
// flagging it pending on each included member. Nothing is sent over SMS yet.
export async function approveCollab(id, { parties, title, description, adminSummary } = {}) {
  const db = getDb();
  const ref = db.collection("collabs").doc(id);
  const existing = await loadCollab(id);
  if (!existing) return null;

  const finalParties = sanitizeParties(parties ?? existing.parties);

  // Stamp the included parties as invited; collect them for in-app delivery.
  const nowIso = new Date().toISOString();
  const inMemberIds = [];
  for (const p of finalParties) {
    if (p.partyStatus === "out") continue;
    p.invitedAt = p.invitedAt ?? nowIso;
    inMemberIds.push(p.memberId);
  }

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

  await attachPendingToMembers(id, inMemberIds);
  await recordProposed(inMemberIds);
  return { id, status: "approved", matchLogIds, invited: inMemberIds.length };
}

// Hydrate a member's pending collabs (by id) for the connector prompt.
export async function loadCollabsByIds(ids = []) {
  if (!ids.length) return [];
  const db = getDb();
  const refs = ids.map(id => db.collection("collabs").doc(id));
  const snaps = await db.getAll(...refs);
  return snaps.filter(s => s.exists).map(s => ({ id: s.id, ...s.data() }));
}

// The collab options this member still owes a response on — what the connector
// agent presents as numbered options. Skips ones they've answered or are out of.
export function pendingOptionsFor(collabs, memberId) {
  const opts = [];
  for (const c of collabs || []) {
    if (c.status !== "approved") continue;
    const me = (c.parties || []).find(p => p.memberId === memberId);
    if (!me || me.partyStatus === "out" || me.response) continue;
    const others = (c.parties || [])
      .filter(p => p.memberId !== memberId && p.partyStatus !== "out")
      .map(p => ({ name: p.memberName, memberType: p.memberType, role: p.role }));
    opts.push({
      collabId: c.id,
      type: c.type,
      title: c.title || null,
      yourRole: me.role || null,
      yourMessage: me.message || null,
      others,
    });
  }
  return opts;
}

// Record a member's in-app response to a collab option and clear it from their
// pending list. Each party-pair stays a labeled example for the learning loop.
export async function recordCollabResponse(collabId, memberId, { decision, note = null } = {}) {
  const db = getDb();
  const collab = await loadCollab(collabId);
  if (!collab) return null;
  const parties = (collab.parties || []).map(p =>
    p.memberId === memberId
      ? { ...p, response: { decision, note, respondedAt: new Date().toISOString() } }
      : p,
  );
  await db.collection("collabs").doc(collabId).update({ parties });
  await db.collection("members").doc(memberId).set(
    { pendingCollabs: FieldValue.arrayRemove(collabId) },
    { merge: true },
  );
  await recordResponse(memberId, decision);
  return { collabId, memberId, decision };
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
