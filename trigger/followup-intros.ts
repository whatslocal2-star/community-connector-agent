import { schedules } from "@trigger.dev/sdk";
import { initObservability, captureError, trackEvent, flushObservability } from "../netlify/functions/lib/observability.js";

// Runs hourly. Finds matchLogs that are >=48h old and still "pending",
// sends a follow-up message asking how the intro/recommendation went,
// then flips the log to "followed_up". When the member replies, the
// chat/sms handlers extract the outcome and flip it to "completed".

export const followupIntros = schedules.task({
  id: "followup-intros",
  cron: "0 * * * *",
  run: async () => {
    // DISABLED (2026-07-08) — paused for now. Re-enable by setting
    // FOLLOWUP_INTROS_ENABLED=1 in the Trigger.dev env.
    if (process.env.FOLLOWUP_INTROS_ENABLED !== "1") return { disabled: true };
    initObservability({ context: "trigger.followup-intros" });
    const { initializeApp, cert, getApps } = await import("firebase-admin/app");
    const { getFirestore, FieldValue } = await import("firebase-admin/firestore");

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

    const cutoffMs = Date.now() - 48 * 60 * 60 * 1000;
    const snap = await db.collection("matchLogs").where("status", "==", "pending").get();
    const due = snap.docs.filter(d => d.data().introducedAt?.toMillis?.() <= cutoffMs);

    let sent = 0;
    let skipped = 0;

    for (const doc of due) {
      const log = doc.data();
      const followUpText = buildFollowUpText(log);

      try {
        if (log.channel === "sms") {
          const member = await db.collection("members").doc(log.memberId).get();
          const phone = member.data()?.phone;
          if (!phone) { skipped++; continue; }
          await sendSms(phone, process.env.TELNYX_FROM_NUMBER!, followUpText);
        } else {
          // Web — drop a system-initiated assistant turn into the member's
          // history so it appears on their next chat load.
          await db.collection("members").doc(log.memberId).set({
            history: FieldValue.arrayUnion({ role: "assistant", content: followUpText }),
          }, { merge: true });
        }

        await doc.ref.update({
          status: "followed_up",
          followUpSentAt: FieldValue.serverTimestamp(),
          followUpText,
        });
        trackEvent(log.memberId, "followup_sent", {
          channel: log.channel,
          matchLogId: doc.id,
          matchedMemberId: log.matchedMemberId,
        });
        sent++;
      } catch (err: any) {
        captureError(err, { job: "followup-intros", matchLogId: doc.id, channel: log.channel });
      }
    }

    trackEvent("system", "followup_run", { sent, skipped, candidates: due.length });
    await flushObservability();
    return { sent, skipped, candidates: due.length };
  },
});

function buildFollowUpText(log: any): string {
  const who = log.matchedMemberName ? ` with ${log.matchedMemberName}` : "";
  return `Hey${log.memberName ? ` ${log.memberName}` : ""}! A couple days ago we connected you${who}. Curious how it went — even a quick thought helps us find better matches for you next time.`;
}

async function sendSms(to: string, from: string, text: string) {
  const res = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, text }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Telnyx send failed: ${res.status} ${err}`);
  }
}
