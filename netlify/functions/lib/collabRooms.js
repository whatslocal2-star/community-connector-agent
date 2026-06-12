import { getDb } from "./db.js";
import { FieldValue } from "firebase-admin/firestore";

// collabRooms/{roomId} — a multi-party chat room where interested collab
// parties finalize a collaboration. Rendered on the marketplace vendor side;
// the data lives here in Firestore.
// {
//   collabId, title, type,
//   participants: [{ memberId, memberName, memberType, role }],
//   participantIds: [memberId],          // parallel array for array-contains
//   status: "open" | "closed",
//   proceedVotes: { [memberId]: "proceed" | "skip" },
//   outcome: "proceeding" | "skipped" | null,
//   createdAt, closedAt,
// }
// Messages live in collabRooms/{roomId}/messages/{id}:
//   { senderId, senderName, text, system, createdAt }

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

// Parties still in the running (not removed) who said they're interested.
export function interestedParties(collab) {
  return (collab?.parties || []).filter(
    p => p.partyStatus !== "out" && p.response?.decision === "interested",
  );
}

// A room is worth opening once a majority of the included parties are
// interested — and never with fewer than two people to talk to.
export function majorityInterested(collab) {
  const included = (collab?.parties || []).filter(p => p.partyStatus !== "out");
  const interested = interestedParties(collab).length;
  return interested >= 2 && interested >= Math.ceil(included.length / 2);
}

export function isParticipant(room, memberId) {
  return Boolean(room?.participantIds?.includes(memberId));
}

// Resolve a proceed/skip vote tally against the room's participants. Majority
// either way decides; otherwise it stays open and pending.
export function voteOutcome(room) {
  const total = room?.participantIds?.length || 0;
  if (!total) return null;
  const votes = Object.values(room.proceedVotes || {});
  const proceed = votes.filter(v => v === "proceed").length;
  const skip = votes.filter(v => v === "skip").length;
  const majority = Math.floor(total / 2) + 1;
  if (proceed >= majority) return "proceeding";
  if (skip >= majority) return "skipped";
  return null;
}

// ── Firestore operations ────────────────────────────────────────────────────

export async function loadRoom(roomId) {
  const db = getDb();
  const doc = await db.collection("collabRooms").doc(roomId).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

export async function loadRoomByCollab(collabId) {
  const db = getDb();
  const snap = await db.collection("collabRooms").where("collabId", "==", collabId).limit(1).get();
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...d.data() };
}

// Open (or return the existing) room for a collab, seeded with the parties who
// said they're interested. Also stamps roomId back on the collab. Idempotent:
// re-opening returns the existing open room.
export async function openRoomForCollab(collab) {
  const existing = await loadRoomByCollab(collab.id);
  if (existing && existing.status === "open") return { roomId: existing.id, reused: true };

  const parties = interestedParties(collab);
  if (parties.length < 2) return { error: "need at least 2 interested parties to open a room" };

  const db = getDb();
  const ref = db.collection("collabRooms").doc();
  const participants = parties.map(p => ({
    memberId: p.memberId,
    memberName: p.memberName ?? null,
    memberType: p.memberType ?? null,
    role: p.role ?? null,
  }));
  await ref.set({
    collabId: collab.id,
    title: collab.title ?? null,
    type: collab.type ?? null,
    participants,
    participantIds: participants.map(p => p.memberId),
    status: "open",
    proceedVotes: {},
    outcome: null,
    createdAt: FieldValue.serverTimestamp(),
    closedAt: null,
  });

  // System welcome so the room isn't empty on first load.
  const who = participants.map(p => p.memberName || p.memberType || "a member").join(", ");
  await ref.collection("messages").add({
    senderId: "system",
    senderName: "Convener",
    text: collab.title
      ? `You've been connected to plan "${collab.title}". Say hi — ${who} are here to make it happen.`
      : `You've been connected to collaborate. Say hi — ${who} are here.`,
    system: true,
    createdAt: FieldValue.serverTimestamp(),
  });

  await db.collection("collabs").doc(collab.id).update({ roomId: ref.id });
  return { roomId: ref.id, reused: false };
}

export async function listRoomsForMember(memberId) {
  const db = getDb();
  const snap = await db.collection("collabRooms")
    .where("participantIds", "array-contains", memberId)
    .limit(50)
    .get();
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
}

export async function loadMessages(roomId, { limit = 100 } = {}) {
  const db = getDb();
  const snap = await db.collection("collabRooms").doc(roomId)
    .collection("messages").orderBy("createdAt", "asc").limit(limit).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function postMessage(roomId, { senderId, senderName, text, system = false }) {
  const db = getDb();
  const ref = await db.collection("collabRooms").doc(roomId).collection("messages").add({
    senderId,
    senderName: senderName ?? null,
    text,
    system,
    createdAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

// Record a participant's proceed/skip vote; close the room if a majority lands.
export async function recordProceedVote(roomId, memberId, vote) {
  const db = getDb();
  const ref = db.collection("collabRooms").doc(roomId);
  const room = await loadRoom(roomId);
  if (!room) return null;
  const proceedVotes = { ...(room.proceedVotes || {}), [memberId]: vote };
  const outcome = voteOutcome({ ...room, proceedVotes });
  const update = { proceedVotes };
  if (outcome) {
    update.outcome = outcome;
    update.status = "closed";
    update.closedAt = FieldValue.serverTimestamp();
  }
  await ref.update(update);
  return { roomId, vote, outcome };
}
