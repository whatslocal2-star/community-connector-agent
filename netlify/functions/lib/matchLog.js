import { getDb } from "./db.js";
import { FieldValue } from "firebase-admin/firestore";

// matchLogs/{id}
// {
//   memberId, memberName,
//   matchedMemberId, matchedMemberName,
//   reason: string,                   // why this match was suggested
//   channel: "sms" | "web",
//   status: "pending" | "followed_up" | "completed",
//   introducedAt, followUpSentAt, outcomeReceivedAt,
//   followUpText,                     // what the bot said when asking
//   outcomeRaw,                       // raw natural-language reply
//   outcome: {                        // GPT-extracted structured signal
//     attended, sentiment, reasons_positive[], reasons_negative[],
//     would_repeat, implicit_profile_updates {}
//   }
// }

export async function createMatchLog({ memberId, memberName, matchedMemberId, matchedMemberName, reason, channel = "web" }) {
  const db = getDb();
  const ref = db.collection("matchLogs").doc();
  await ref.set({
    memberId,
    memberName: memberName ?? null,
    matchedMemberId: matchedMemberId ?? null,
    matchedMemberName: matchedMemberName ?? null,
    reason: reason ?? null,
    channel,
    status: "pending",
    introducedAt: FieldValue.serverTimestamp(),
    followUpSentAt: null,
    outcomeReceivedAt: null,
  });
  return ref.id;
}

export async function loadPendingFollowUps({ hoursOld = 48 } = {}) {
  const db = getDb();
  const cutoffMs = Date.now() - hoursOld * 60 * 60 * 1000;
  const snap = await db.collection("matchLogs").where("status", "==", "pending").get();
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(l => l.introducedAt?.toMillis?.() <= cutoffMs);
}

export async function recordFollowUpSent(matchLogId, followUpText) {
  const db = getDb();
  await db.collection("matchLogs").doc(matchLogId).update({
    status: "followed_up",
    followUpSentAt: FieldValue.serverTimestamp(),
    followUpText: followUpText ?? null,
  });
}

export async function recordOutcome(matchLogId, { raw, outcome }) {
  const db = getDb();
  await db.collection("matchLogs").doc(matchLogId).update({
    status: "completed",
    outcomeReceivedAt: FieldValue.serverTimestamp(),
    outcomeRaw: raw ?? null,
    outcome: outcome ?? null,
  });
}

export async function loadAwaitingOutcome(memberId) {
  const db = getDb();
  const snap = await db.collection("matchLogs").where("memberId", "==", memberId).get();
  if (snap.empty) return null;
  const followed = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(l => l.status === "followed_up")
    .sort((a, b) => (b.followUpSentAt?.toMillis?.() ?? 0) - (a.followUpSentAt?.toMillis?.() ?? 0));
  return followed[0] ?? null;
}

export async function loadMatchLogs({ memberId, status, limit = 100 } = {}) {
  const db = getDb();
  let q = db.collection("matchLogs");
  if (memberId) q = q.where("memberId", "==", memberId);
  if (status) q = q.where("status", "==", status);
  const snap = await q.limit(limit).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
