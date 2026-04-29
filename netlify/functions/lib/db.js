import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

export function getDb() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
      }),
    });
  }
  return getFirestore();
}

export async function loadMember(id) {
  const db = getDb();
  const doc = await db.collection("members").doc(id).get();
  if (!doc.exists) return null;
  const { history, ...rest } = doc.data();
  return { id: doc.id, ...rest };
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
  return snap.docs.map(doc => {
    const { history, ...rest } = doc.data();
    return { id: doc.id, ...rest };
  });
}

export async function saveMember(id, { history, profileUpdate, meta = {} }) {
  const db = getDb();
  const ref = db.collection("members").doc(id);

  // set() with merge:true handles base fields and creates doc if needed
  const base = { lastActiveAt: FieldValue.serverTimestamp(), ...meta };
  if (history) base.history = history;
  await ref.set(base, { merge: true });

  // update() treats dot-notation as nested field paths — safe for incremental profile merging
  if (profileUpdate) {
    const fields = {};
    for (const [k, v] of Object.entries(profileUpdate)) {
      if (v !== undefined && v !== null) {
        fields[`profile.${k}`] = v;
      }
    }
    if (Object.keys(fields).length) {
      await ref.update(fields);
    }
  }
}
