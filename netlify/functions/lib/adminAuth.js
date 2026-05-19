import crypto from "crypto";

// Timing-safe bearer-token check for admin endpoints.
// Returns true only when the request carries `Authorization: Bearer <ADMIN_TOKEN>`.
export function isAdminAuthorized(event) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;
  const auth = event?.headers?.authorization || event?.headers?.Authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function unauthorized() {
  return { statusCode: 401, body: "Unauthorized" };
}
