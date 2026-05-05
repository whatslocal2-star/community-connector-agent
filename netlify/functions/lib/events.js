import { getDb } from "./db.js";
import { FieldValue } from "firebase-admin/firestore";

export async function saveEventSuggestion(suggestion) {
  const db = getDb();
  const ref = db.collection("eventSuggestions").doc();
  await ref.set({
    ...suggestion,
    status: "pending",
    createdAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export async function loadEventSuggestions({ status, memberId, limit = 50 } = {}) {
  const db = getDb();
  let query = db.collection("eventSuggestions")
    .orderBy("createdAt", "desc")
    .limit(limit);

  if (status) query = query.where("status", "==", status);
  if (memberId) query = query.where("memberId", "==", memberId);

  const snap = await query.get();
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

export async function updateEventSuggestionStatus(id, status) {
  const db = getDb();
  await db.collection("eventSuggestions").doc(id).update({
    status,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

export async function updateSubscriptionLastChecked(memberId, platform) {
  const db = getDb();
  await db.collection("members").doc(memberId)
    .collection("subscriptions").doc(platform)
    .update({ lastCheckedAt: FieldValue.serverTimestamp() });
}
