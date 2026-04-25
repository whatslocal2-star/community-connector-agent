import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

function getDb() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        // Netlify env vars escape newlines — unescape them
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
      }),
    });
  }
  return getFirestore();
}

export async function loadConversation(id) {
  const db = getDb();
  const doc = await db.collection("members").doc(id).get();
  if (!doc.exists) return [];
  return doc.data().history ?? [];
}

export async function loadAllMembers(limit = 500) {
  const db = getDb();
  const snap = await db.collection("members")
    .orderBy("lastActiveAt", "desc")
    .limit(limit)
    .get();
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data(), history: undefined }));
}

export async function saveMember(id, { history, profileUpdate, meta = {} }) {
  const db = getDb();
  const update = { lastActiveAt: FieldValue.serverTimestamp(), ...meta };

  if (history) update.history = history;

  if (profileUpdate) {
    for (const [k, v] of Object.entries(profileUpdate)) {
      if (v !== undefined && v !== null) {
        update[`profile.${k}`] = v;
      }
    }
  }

  await db.collection("members").doc(id).set(update, { merge: true });
}
