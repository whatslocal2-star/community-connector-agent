import { getDb } from "./db.js";
import { FieldValue } from "firebase-admin/firestore";

// matchFormats/{signature} — a collaboration "shape" that has worked, distilled
// from collabs whose room reached a proceed majority. Lets us recur the format
// with all-new parties, and (via per-member formatAffinity) lean a member's
// future proposals toward the kind of collab they've said yes to before.
// {
//   signature, type, typeLineup: [memberType...], exampleTitle,
//   wins, sourceCollabIds: [], lastWonAt,
// }

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

// Canonical shape of a collab: type + its sorted included member types.
// e.g. { type:"event", parties:[vendor, artist, organizer] } → "event|artist+organizer+vendor"
export function formatSignature(collab) {
  const types = (collab?.parties || [])
    .filter(p => p.partyStatus !== "out")
    .map(p => p.memberType || "unknown")
    .sort();
  return `${collab?.type || "collab"}|${types.join("+")}`;
}

// The member-type lineup encoded in a signature ("event|artist+vendor" → [artist, vendor]).
export function parseLineup(signature) {
  const tail = String(signature || "").split("|")[1] || "";
  return tail ? tail.split("+") : [];
}

// The lineup a member most often says yes to, from their cached affinity map.
export function topAffinityLineup(formatAffinity) {
  const entries = Object.entries(formatAffinity || {});
  if (!entries.length) return null;
  entries.sort((a, b) => b[1] - a[1]);
  const lineup = parseLineup(entries[0][0]);
  return lineup.length ? lineup : null;
}

// ── Firestore ───────────────────────────────────────────────────────────────

// Record that this collab's shape worked. Keyed by signature so repeats of the
// same shape accumulate wins. (Signatures contain '+' and '|', both valid in a
// Firestore doc id.)
export async function recordFormatWin(collab) {
  const signature = formatSignature(collab);
  const typeLineup = (collab.parties || [])
    .filter(p => p.partyStatus !== "out")
    .map(p => p.memberType || "unknown")
    .sort();
  const db = getDb();
  await db.collection("matchFormats").doc(signature).set({
    signature,
    type: collab.type || null,
    typeLineup,
    exampleTitle: collab.title || null,
    wins: FieldValue.increment(1),
    sourceCollabIds: FieldValue.arrayUnion(collab.id),
    lastWonAt: new Date().toISOString(),
  }, { merge: true });
  return signature;
}

export async function loadFormats({ limit = 25 } = {}) {
  const db = getDb();
  const snap = await db.collection("matchFormats").limit(limit).get();
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.wins || 0) - (a.wins || 0));
}

export async function loadFormat(signature) {
  const db = getDb();
  const doc = await db.collection("matchFormats").doc(signature).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}
