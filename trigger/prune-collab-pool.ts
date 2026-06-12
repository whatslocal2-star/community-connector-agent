import { schedules } from "@trigger.dev/sdk";
import { assessPool } from "../netlify/functions/lib/collabActivity.js";
import { initObservability, captureError, trackEvent, flushObservability } from "../netlify/functions/lib/observability.js";

// Runs weekly (Mon 7am). Enforces "active and collaborating to stay in the
// network": reassesses every member's collab pool standing from their activity
// and writes any change. Removed members stop being surfaced as candidates;
// returning/active members are restored. Non-destructive — only flips a status.

export const pruneCollabPool = schedules.task({
  id: "prune-collab-pool",
  cron: "0 7 * * 1",
  run: async () => {
    initObservability({ context: "trigger.prune-collab-pool" });
    const { initializeApp, cert, getApps } = await import("firebase-admin/app");
    const { getFirestore } = await import("firebase-admin/firestore");

    if (!getApps().length) {
      initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
        }),
      });
    }
    const db = getFirestore();
    const now = Date.now();

    const snap = await db.collection("members").get();
    const tally = { active: 0, dormant: 0, removed: 0, changed: 0 };
    let batch = db.batch();
    let pending = 0;

    for (const doc of snap.docs) {
      const member = { id: doc.id, ...doc.data() } as any;
      if (!member.profile) continue;

      const { poolStatus, reason } = assessPool(member, now);
      tally[poolStatus as "active" | "dormant" | "removed"]++;

      const current = member.collabActivity?.poolStatus || "active";
      if (current === poolStatus) continue;

      batch.set(doc.ref, {
        collabActivity: { poolStatus, poolReason: reason, poolAssessedAt: new Date(now).toISOString() },
      }, { merge: true });
      tally.changed++;
      pending++;

      // Firestore batches cap at 500 writes.
      if (pending >= 400) {
        await batch.commit();
        batch = db.batch();
        pending = 0;
      }

      if (poolStatus === "removed") {
        trackEvent(doc.id, "collab_pool_removed", { reason });
      }
    }

    if (pending > 0) await batch.commit();

    trackEvent("system", "collab_pool_pruned", tally);
    await flushObservability();
    return tally;
  },
});
