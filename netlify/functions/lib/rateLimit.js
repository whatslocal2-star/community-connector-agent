import { getDb } from "./db.js";

// Fixed-window rate limiting backed by Firestore.
//
// Netlify functions are stateless and horizontally scaled, so an in-memory
// counter would only see a fraction of the traffic. Firestore is the shared
// store we already run, and a single read+write per request is an order of
// magnitude cheaper than the OpenAI/Pinecone calls these limiters guard.
//
// Each (key, window) pair is one doc in `rateLimits`. We bump a counter in a
// transaction so concurrent requests can't race past the cap. Docs carry an
// `expiresAt` so a Firestore TTL policy on that field can auto-purge them
// (configure once in the console; harmless if not set).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// Best-effort client IP from Netlify's edge headers, falling back to the
// standard forwarded chain. "unknown" buckets unattributable traffic together
// (fails toward stricter, which is the safe direction for abuse control).
export function clientIp(event) {
  const h = event?.headers || {};
  return (
    h["x-nf-client-connection-ip"] ||
    h["client-ip"] ||
    (h["x-forwarded-for"] || "").split(",")[0].trim() ||
    "unknown"
  );
}

/**
 * @param {{ key: string, limit: number, windowSec: number }} opts
 * @returns {Promise<{ allowed: boolean, remaining: number, retryAfter: number }>}
 */
export async function checkRateLimit({ key, limit, windowSec }) {
  const now = Date.now();
  const windowMs = windowSec * 1000;
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const docId = `${key}_${windowStart}`;

  try {
    const db = getDb();
    const ref = db.collection("rateLimits").doc(docId);
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const count = snap.exists ? snap.data().count || 0 : 0;
      if (count >= limit) {
        return {
          allowed: false,
          remaining: 0,
          retryAfter: Math.ceil((windowStart + windowMs - now) / 1000),
        };
      }
      tx.set(
        ref,
        {
          count: count + 1,
          windowStart,
          // 2x window so a TTL sweep never deletes a live counter.
          expiresAt: new Date(windowStart + windowMs * 2),
        },
        { merge: true },
      );
      return { allowed: true, remaining: limit - count - 1, retryAfter: 0 };
    });
  } catch (err) {
    // Fail OPEN: a limiter outage must never take down the endpoint it guards.
    console.error("rateLimit error:", err);
    return { allowed: true, remaining: limit, retryAfter: 0 };
  }
}

// 429 response shaped like the rest of the function handlers.
export function tooManyRequests(retryAfter, extraHeaders = {}) {
  return {
    statusCode: 429,
    headers: {
      ...corsHeaders,
      ...extraHeaders,
      "Content-Type": "application/json",
      "Retry-After": String(Math.max(retryAfter, 1)),
    },
    body: JSON.stringify({
      error: "Too many requests. Please slow down and try again shortly.",
      retryAfter,
    }),
  };
}

/**
 * One-call guard for a handler: checks the limit and returns a ready-to-return
 * 429 response when exceeded, or null when the request may proceed.
 *
 * @returns {Promise<object|null>}
 */
export async function enforceRateLimit(event, { name, limit, windowSec }) {
  const ip = clientIp(event);
  const { allowed, retryAfter } = await checkRateLimit({
    key: `${name}:${ip}`,
    limit,
    windowSec,
  });
  return allowed ? null : tooManyRequests(retryAfter);
}
