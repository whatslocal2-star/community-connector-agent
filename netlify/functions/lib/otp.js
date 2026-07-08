// Outbound one-time-code possession check.
//
// This is the correct possession gate (see features/verification.md in the
// marketplace repo): we SEND a code TO the business's authoritative phone and
// the claimer reads it back. Receiving at a number can't be spoofed; an inbound
// caller-ID / SMS `From` can — so this replaces the old inbound routing.
//
// The target phone is the profile's authoritative ownership phone, resolved in
// priority order (admin-set trusted number → profile number → the Google Maps
// listed number via Places). The public/typed number is never accepted as proof
// on its own; only possession of it (receiving the code) verifies.
//
// Delivery + code lifecycle is handled by Twilio Verify (twilio.js) — Twilio
// generates the code, delivers it (SMS, or a voice CALL for landlines), and owns
// expiry + wrong-attempt caps using its pre-vetted 2FA pool (no 10DLC). We store
// only the target phone (never the code) so the verify step knows which number to
// check against; the code itself is never at rest here.

import { getDb } from "./db.js";
import { resolveOwnershipPhone } from "./verify.js";
import { sendVerification, checkVerification } from "./twilio.js";

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes — our own guard alongside Twilio's

// Show only the last 4 digits back to the claimer so they can confirm it went to
// the right number without us leaking the full (sometimes private) number.
function maskPhone(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  if (d.length < 4) return "•••";
  return `•••••${d.slice(-4)}`;
}

/**
 * Start a verification to the profile's authoritative ownership phone via Twilio
 * Verify, and remember which phone it went to. Returns a masked hint of where.
 * @param {string} memberId
 * @param {Record<string, any>} profile
 * @param {"sms"|"call"} [channel] SMS by default; "call" for landlines.
 * @returns {Promise<{ sent: boolean, phoneHint?: string, reason?: string }>}
 */
export async function issueOtp(memberId, profile, channel = "sms") {
  const phone = await resolveOwnershipPhone(profile);
  if (!phone) return { sent: false, reason: "no_phone" };

  const db = getDb();
  // Store ONLY the phone (+ TTL guard). Twilio holds the code.
  await db.collection("otps").doc(memberId).set({
    phone,
    channel,
    createdAt: new Date(),
    // TTL field: configure a Firestore TTL policy on `expiresAt` to auto-purge.
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
  });

  await sendVerification(phone, channel);
  return { sent: true, phoneHint: maskPhone(phone) };
}

/**
 * Check a submitted code against Twilio Verify for the phone we sent it to.
 * Deletes our record on success (single-use). Twilio enforces its own expiry +
 * attempt caps; our expiresAt is a belt-and-suspenders guard.
 * @param {string} memberId
 * @param {string} code
 * @returns {Promise<{ verified: boolean, evidence: Record<string, any> }>}
 */
export async function verifyOtp(memberId, code) {
  const db = getDb();
  const ref = db.collection("otps").doc(memberId);
  const snap = await ref.get();
  if (!snap.exists) return { verified: false, evidence: { reason: "no_code" } };

  const data = snap.data();
  const expiresAt = data.expiresAt?.toDate ? data.expiresAt.toDate() : new Date(data.expiresAt);
  if (Date.now() > expiresAt.getTime()) {
    await ref.delete();
    return { verified: false, evidence: { reason: "expired" } };
  }

  const ok = await checkVerification(data.phone, String(code).trim());
  if (!ok) {
    // Twilio counts the failed attempt; don't delete so the claimer can retry
    // until Twilio's own cap or our TTL trips.
    return { verified: false, evidence: { reason: "mismatch" } };
  }

  await ref.delete();
  return { verified: true, evidence: { source: "phone_otp", phone: maskPhone(data.phone) } };
}
