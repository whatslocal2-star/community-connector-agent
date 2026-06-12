import { getDb } from "./db.js";
import { FieldValue } from "firebase-admin/firestore";

// "Active and collaborating to stay in the network." A member's collab pool
// standing is tracked on `members/{id}.collabActivity`:
//   { lastProposedAt, lastRespondedAt, lastInterestedAt, declineStreak,
//     poolStatus: "active" | "dormant" | "removed", poolReason, poolAssessedAt,
//     nudgedAt }
// Removed members are excluded from matching (see convener.loadMatchPool).

export const DECLINE_NUDGE_AT = 2;   // ask "what should change?" after this many declines
export const DECLINE_REMOVE_AT = 4;  // drop from the pool after this many — if also quiet
export const STALE_DAYS = 14;        // decline-removal also requires this much silence
export const DORMANT_DAYS = 30;      // no app activity this long → dormant
export const REMOVE_DAYS = 60;       // dormant this long → removed

const DAY = 24 * 60 * 60 * 1000;
const iso = () => new Date().toISOString();
const ms = (v) => (typeof v === "string" ? Date.parse(v) || 0 : v?.toMillis?.() ?? 0);

// Pure: a member's pool standing from their activity. Used by the prune cron
// (to set poolStatus) and by chat (shouldNudge). Harvested seed profiles are
// always kept — they're candidates to be discovered, not active users.
export function assessPool(member, now = Date.now()) {
  if (member?.status === "unclaimed" || member?.source === "google_places_harvest") {
    return { poolStatus: "active", reason: "harvested seed", shouldNudge: false };
  }
  const a = member?.collabActivity || {};
  const lastActiveMs = Math.max(ms(member?.lastActiveAt), ms(a.lastRespondedAt), ms(a.lastProposedAt));
  if (!lastActiveMs) {
    // No signal at all (malformed/legacy doc) — never remove on missing data.
    return { poolStatus: "active", reason: "no activity signal", shouldNudge: false };
  }
  const idleDays = (now - lastActiveMs) / DAY;
  const declines = a.declineStreak || 0;

  let poolStatus = "active";
  let reason = "active";
  if (idleDays >= REMOVE_DAYS) {
    poolStatus = "removed";
    reason = `inactive ${Math.round(idleDays)}d`;
  } else if (declines >= DECLINE_REMOVE_AT && idleDays >= STALE_DAYS) {
    poolStatus = "removed";
    reason = `declined ${declines}, quiet ${Math.round(idleDays)}d`;
  } else if (idleDays >= DORMANT_DAYS) {
    poolStatus = "dormant";
    reason = `idle ${Math.round(idleDays)}d`;
  }

  // Only nudge members who are still active — an in-chat ask to recalibrate
  // what they need/offer so future collabs land better. Once a week at most.
  const shouldNudge =
    poolStatus === "active" &&
    declines >= DECLINE_NUDGE_AT &&
    (!a.nudgedAt || now - ms(a.nudgedAt) >= 7 * DAY);

  return { poolStatus, reason, shouldNudge };
}

// ── Firestore writes (set+merge so collabActivity sub-fields are preserved) ──

export async function recordProposed(memberIds = []) {
  if (!memberIds.length) return;
  const db = getDb();
  const batch = db.batch();
  for (const mid of memberIds) {
    batch.set(db.collection("members").doc(mid), { collabActivity: { lastProposedAt: iso() } }, { merge: true });
  }
  await batch.commit();
}

export async function recordResponse(memberId, decision, { signature = null } = {}) {
  const db = getDb();
  const ref = db.collection("members").doc(memberId);
  if (decision === "interested") {
    // Engaging resets the decline streak and reactivates them. We also bump
    // this member's affinity for the collab's format so future proposals lean
    // toward shapes they've said yes to (with all-new counterparts).
    const activity = { lastRespondedAt: iso(), lastInterestedAt: iso(), declineStreak: 0, poolStatus: "active" };
    if (signature) activity.formatAffinity = { [signature]: FieldValue.increment(1) };
    await ref.set({ collabActivity: activity }, { merge: true });
  } else if (decision === "declined") {
    await ref.set({
      collabActivity: { lastRespondedAt: iso(), declineStreak: FieldValue.increment(1) },
    }, { merge: true });
  } else {
    // "maybe" — neutral; just record that they engaged.
    await ref.set({ collabActivity: { lastRespondedAt: iso() } }, { merge: true });
  }
}

export async function recordNudged(memberId) {
  await getDb().collection("members").doc(memberId)
    .set({ collabActivity: { nudgedAt: iso() } }, { merge: true });
}

export async function setPoolStatus(memberId, poolStatus, reason = null) {
  await getDb().collection("members").doc(memberId)
    .set({ collabActivity: { poolStatus, poolReason: reason, poolAssessedAt: iso() } }, { merge: true });
}
