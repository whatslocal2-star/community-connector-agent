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
  // Fetch a broad set then filter in-memory to avoid composite index requirements
  const snap = await db.collection("eventSuggestions")
    .orderBy("createdAt", "desc")
    .limit(500)
    .get();

  let results = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  if (status) results = results.filter(e => e.status === status);
  if (memberId) results = results.filter(e => e.memberId === memberId);
  return results.slice(0, limit);
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
