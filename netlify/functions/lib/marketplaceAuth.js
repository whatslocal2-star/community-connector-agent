import crypto from "crypto";

// Shared-secret check for marketplace-facing endpoints. The community-marketplace
// Next.js server (which authenticates its own vendor users) calls these from the
// server side with `Authorization: Bearer <MARKETPLACE_API_KEY>` and asserts the
// acting member_id in the request body. The secret never reaches the browser.
export function isMarketplaceAuthorized(event) {
  const expected = process.env.MARKETPLACE_API_KEY;
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
