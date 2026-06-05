import { loadAllMembers, saveMember } from "./lib/db.js";
import { parsePriceRange, normalizePricePerProduct } from "./lib/priceParse.js";
import { upsertMemberVector } from "./lib/vectorSearch.js";
import { isAdminAuthorized, unauthorized } from "./lib/adminAuth.js";

// Admin endpoint:
// - parse profile.priceRange (string) into priceMin / priceMax numerics
// - normalize pricePerProduct entries
// - re-embed so Pinecone metadata + the offers/needs namespaces pick up the
//   new structured fields
// Run after deploying the structured-search schema changes.
//
// PAGINATED so it fits the Netlify function timeout: pass ?offset=&limit= and
// loop until the response's `nextOffset` is null. Ordering is by doc id (stable
// across calls — the in-loop saves bump lastActiveAt, which would otherwise
// shuffle the page boundaries).
export const handler = async (event) => {
  if (!isAdminAuthorized(event)) return unauthorized();

  const qs = event.queryStringParameters || {};
  const reembedAll = qs.reembedAll === "1";
  const offset = Math.max(0, parseInt(qs.offset || "0", 10) || 0);
  const limit = Math.min(Math.max(parseInt(qs.limit || "25", 10) || 25, 1), 200);

  const all = await loadAllMembers(2000);
  all.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const members = all.slice(offset, offset + limit);
  const nextOffset = offset + limit < all.length ? offset + limit : null;
  const results = [];

  for (const m of members) {
    const profile = m.profile || {};
    const update = {};

    if (profile.priceRange && profile.priceMin == null && profile.priceMax == null) {
      const parsed = parsePriceRange(profile.priceRange);
      if (parsed) {
        if (parsed.priceMin != null) update.priceMin = parsed.priceMin;
        if (parsed.priceMax != null) update.priceMax = parsed.priceMax;
      }
    }

    if (Array.isArray(profile.pricePerProduct) && profile.pricePerProduct.length) {
      const normalized = normalizePricePerProduct(profile.pricePerProduct);
      const looksDifferent = JSON.stringify(normalized) !== JSON.stringify(profile.pricePerProduct);
      if (looksDifferent) update.pricePerProduct = normalized;
    }

    const changed = Object.keys(update).length > 0;
    if (changed) {
      await saveMember(m.id, { profileUpdate: update });
    }

    if (changed || reembedAll) {
      try {
        await upsertMemberVector(m.id, { ...profile, ...update });
        results.push({ id: m.id, name: profile.name, ...update, reembedded: true });
      } catch (err) {
        results.push({ id: m.id, name: profile.name, error: String(err?.message || err) });
      }
    }
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      total: all.length,
      offset,
      limit,
      processed: members.length,
      updated: results.length,
      nextOffset,
      results,
    }),
  };
};
