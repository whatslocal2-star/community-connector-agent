// Twilio Verify — managed one-time-code delivery for the business-ownership
// possession check. Twilio owns code generation, delivery, expiry, and
// wrong-attempt caps, using its own pre-vetted 2FA sender pool — so it bypasses
// 10DLC campaign registration (the reason we moved OTP off Telnyx). Telnyx stays
// for all other transactional SMS/voice (see telnyx.js).
//
// SMS by default; `channel: "call"` places a voice call reading the code, which
// is the fallback for Google-Maps-listed business LANDLINES that can't receive
// SMS.

let _client = null;

async function client() {
  if (_client) return _client;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    throw new Error("Twilio not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)");
  }
  // Lazy dynamic import so the SDK only loads when OTP is actually exercised.
  const { default: twilio } = await import("twilio");
  _client = twilio(sid, token);
  return _client;
}

function serviceSid() {
  const s = process.env.TWILIO_VERIFY_SERVICE_SID;
  if (!s) throw new Error("Twilio Verify not configured (TWILIO_VERIFY_SERVICE_SID)");
  return s;
}

/**
 * Start a verification: Twilio generates + delivers the code to `to`.
 * @param {string} to E.164 phone
 * @param {"sms"|"call"} channel
 */
export async function sendVerification(to, channel = "sms") {
  const c = await client();
  const v = await c.verify.v2.services(serviceSid()).verifications.create({ to, channel });
  return { status: v.status, channel: v.channel };
}

/**
 * Check a submitted code. Returns true only when Twilio marks it approved.
 * Twilio throws 404 once a verification has expired / been consumed / hit its
 * attempt cap — treat all of those as a failed check, not an error.
 * @param {string} to E.164 phone the code was sent to
 * @param {string} code
 */
export async function checkVerification(to, code) {
  const c = await client();
  try {
    const check = await c.verify.v2.services(serviceSid()).verificationChecks.create({ to, code });
    return check.status === "approved";
  } catch (e) {
    if (e?.status === 404) return false;
    throw e;
  }
}
