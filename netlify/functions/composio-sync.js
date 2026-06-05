import { isAdminAuthorized } from "./lib/adminAuth.js";
import { runTool, TOOL_SLUGS } from "./lib/composio.js";
import { getSupabase } from "./lib/supabase.js";
import { loadMember } from "./lib/db.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Map a Shopify product (REST shape) → a marketplace `products` row.
// Shopify returns variants[]; we take the first variant's price and the first
// image. One row per product (not per variant) for Phase A.
function mapShopifyProduct(p, memberId, memberName) {
  const variant = Array.isArray(p.variants) ? p.variants[0] : null;
  const image = p.image?.src || (Array.isArray(p.images) ? p.images[0]?.src : null) || null;
  return {
    member_id: memberId,
    member_name: memberName,
    name: p.title || "Untitled",
    description: p.body_html ? String(p.body_html).replace(/<[^>]+>/g, "").trim() : null,
    price: variant?.price != null ? Number(variant.price) : 0,
    currency: "USD",
    image_url: image,
    active: true,
    source: "shopify",
    external_id: String(p.id),
  };
}

// Map a Square catalog ITEM object → a marketplace `products` row.
// Square prices are integer cents in price_money.amount. Item images are
// separate IMAGE catalog objects referenced by item.image_ids; `imageMap`
// resolves the first one to a URL (built from the IMAGE objects in the same
// ListCatalog response — see handler).
function mapSquareItem(obj, memberId, memberName, imageMap = {}) {
  const item = obj.item_data || {};
  const variation = Array.isArray(item.variations) ? item.variations[0] : null;
  const priceMoney = variation?.item_variation_data?.price_money;
  const cents = priceMoney?.amount != null ? Number(priceMoney.amount) : 0;
  const imageId = Array.isArray(item.image_ids) ? item.image_ids[0] : null;
  return {
    member_id: memberId,
    member_name: memberName,
    name: item.name || "Untitled",
    description: item.description || null,
    price: cents / 100,
    currency: priceMoney?.currency || "USD",
    image_url: (imageId && imageMap[imageId]) || null,
    active: true,
    source: "square",
    external_id: String(obj.id),
  };
}

// Pull the live catalog for a connected vendor and upsert into Supabase.
//
// POST { memberId }   (Bearer ADMIN_TOKEN)
//   → reads vendor_settings.composio_platform to know which store
//   → lists the catalog via Composio, maps to product rows
//   → upserts on (member_id, external_id); returns { synced, platform }
export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }
  if (!isAdminAuthorized(event)) {
    return { statusCode: 401, headers: corsHeaders, body: "Unauthorized" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders, body: "Method Not Allowed" };
  }

  try {
    const { memberId } = JSON.parse(event.body || "{}");
    if (!memberId) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "memberId required" }) };
    }

    const supabase = getSupabase();
    const { data: settings } = await supabase
      .from("vendor_settings")
      .select("composio_platform")
      .eq("member_id", memberId)
      .single();

    const platform = settings?.composio_platform;
    if (!platform || !TOOL_SLUGS[platform]) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "No connected platform for this member" }) };
    }

    const member = await loadMember(memberId);
    const memberName = member?.profile?.name || "Vendor";

    let rows = [];
    if (platform === "shopify") {
      const data = await runTool(TOOL_SLUGS.shopify.list, memberId, {});
      const products = data?.products || data?.items || (Array.isArray(data) ? data : []);
      rows = products.map((p) => mapShopifyProduct(p, memberId, memberName));
    } else if (platform === "square") {
      // Pull ITEM + IMAGE together so we can resolve item.image_ids → URL in
      // one call instead of a per-item lookup.
      const data = await runTool(TOOL_SLUGS.square.list, memberId, { types: "ITEM,IMAGE" });
      const all = data?.objects || data?.items || [];
      const imageMap = {};
      for (const o of all) {
        if (o.type === "IMAGE" && o.image_data?.url) imageMap[o.id] = o.image_data.url;
      }
      const objects = all.filter((o) => o.type === "ITEM");
      rows = objects.map((o) => mapSquareItem(o, memberId, memberName, imageMap));
    }

    if (rows.length) {
      const { error } = await supabase
        .from("products")
        .upsert(rows, { onConflict: "member_id,external_id" });
      if (error) throw new Error(`products upsert failed: ${error.message}`);
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ synced: rows.length, platform }),
    };
  } catch (err) {
    console.error("composio-sync error:", err);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: err.message || "Sync failed" }) };
  }
};
