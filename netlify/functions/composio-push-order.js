import { isAdminAuthorized } from "./lib/adminAuth.js";
import { runTool, TOOL_SLUGS } from "./lib/composio.js";
import { getSupabase } from "./lib/supabase.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Push a completed marketplace order back into the vendor's store so their
// system of record reflects the sale (and inventory decrements there).
//
// POST { memberId, order }   (Bearer ADMIN_TOKEN)
//   order = the Supabase `orders` row: { order_number, buyer_email, items[], ... }
//   items[] = { name, qty, price_cents, product_id? }
//   → creates an order in the connected platform; returns { pushed, platform }
//
// Fired fire-and-forget from the marketplace's stripe-webhook on
// payment_intent.succeeded, so failures are logged, not surfaced to the buyer.
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
    const { memberId, order } = JSON.parse(event.body || "{}");
    if (!memberId || !order) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "memberId and order required" }) };
    }

    const { data: settings } = await getSupabase()
      .from("vendor_settings")
      .select("composio_platform")
      .eq("member_id", memberId)
      .single();

    const platform = settings?.composio_platform;
    if (!platform || !TOOL_SLUGS[platform]) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "No connected platform for this member" }) };
    }

    const items = Array.isArray(order.items) ? order.items : [];

    if (platform === "shopify") {
      const line_items = items.map((it) => ({
        title: it.name,
        quantity: it.qty,
        price: ((it.price_cents ?? 0) / 100).toFixed(2),
      }));
      await runTool(TOOL_SLUGS.shopify.createOrder, memberId, {
        line_items,
        email: order.buyer_email || undefined,
        financial_status: "paid",
        note: `Marketplace order ${order.order_number}`,
        tags: "community-marketplace",
      });
    } else if (platform === "square") {
      // Square's order shape differs (line_items with base_price_money in cents).
      // Wired but unverified — confirm SQUARE_CREATE_ORDER arg schema in dashboard.
      const line_items = items.map((it) => ({
        name: it.name,
        quantity: String(it.qty),
        base_price_money: { amount: it.price_cents ?? 0, currency: "USD" },
      }));
      await runTool(TOOL_SLUGS.square.createOrder, memberId, { order: { line_items } });
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ pushed: true, platform }),
    };
  } catch (err) {
    console.error("composio-push-order error:", err);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: err.message || "Push failed" }) };
  }
};
