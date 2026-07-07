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

/**
 * @param {string} id
 * @returns {Promise<{ id: string, profile?: Record<string, any>, [k: string]: any } | null>}
 */
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

// Find a member whose profile was pre-tagged with a trusted onboarding number
// (an admin set it in person) OR who has already been linked to that number.
// Powers the possession gate: only a call/text FROM this number may onboard the
// pre-created profile. `phone` must be E.164-normalized. Returns null if none.
export async function findMemberByTrustedPhone(phone) {
  if (!phone) return null;
  const db = getDb();
  for (const field of ["profile.trustedPhone", "profile.ownerPhone"]) {
    const snap = await db.collection("members").where(field, "==", phone).limit(1).get();
    if (!snap.empty) {
      const doc = snap.docs[0];
      const { history, ...rest } = doc.data();
      return { id: doc.id, ...rest };
    }
  }
  return null;
}

export async function saveSubscriptions(memberId, channels) {
  const db = getDb();
  const batch = db.batch();
  for (const ch of channels) {
    const ref = db.collection("members").doc(memberId)
      .collection("subscriptions").doc(ch.type);
    batch.set(ref, {
      ...ch,
      active: true,
      createdAt: FieldValue.serverTimestamp(),
      lastCheckedAt: null,
    }, { merge: true });
  }
  await batch.commit();
}

export async function loadSubscriptions(memberId) {
  const db = getDb();
  const snap = await db.collection("members").doc(memberId)
    .collection("subscriptions").where("active", "==", true).get();
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

export async function loadAllActiveSubscriptions() {
  const db = getDb();
  const membersSnap = await db.collection("members")
    .where("profile.eventPostingPlatforms", "!=", null)
    .get();

  const results = [];
  for (const memberDoc of membersSnap.docs) {
    const subsSnap = await memberDoc.ref.collection("subscriptions")
      .where("active", "==", true).get();
    if (subsSnap.empty) continue;
    const member = memberDoc.data();
    results.push({
      memberId: memberDoc.id,
      name: member.profile?.name,
      subscriptions: subsSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    });
  }
  return results;
}

/**
 * @param {string} id
 * @param {{ history?: any[], profileUpdate?: Record<string, any> | null, meta?: Record<string, any> }} [opts]
 */
export async function saveMember(id, { history, profileUpdate, meta = {} } = {}) {
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
