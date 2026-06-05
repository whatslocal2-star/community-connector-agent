import { isAdminAuthorized } from "./lib/adminAuth.js";
import { getComposio, authConfigIdFor, SUPPORTED_PLATFORMS } from "./lib/composio.js";
import { getSupabase } from "./lib/supabase.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Start a Composio OAuth connection for a vendor's storefront.
//
// POST { memberId, platform: 'shopify'|'square' }   (Bearer ADMIN_TOKEN)
//   → initiates a Composio connection scoped to userId=memberId
//   → records platform + connection id on vendor_settings so the marketplace
//     UI shows "connected" and the order push-back path can gate on it
//   → returns { url } — the redirect the vendor opens to authorize
//
// The vendor authorizes on the platform, Composio redirects to callbackUrl,
// and a subsequent /composio-sync confirms the live connection by listing the
// real catalog. Tool calls are resolved by userId, so no per-call handle is
// stored beyond this flag.
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
    const { memberId, platform } = JSON.parse(event.body || "{}");
    if (!memberId || !platform) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "memberId and platform required" }) };
    }
    if (!SUPPORTED_PLATFORMS.includes(platform)) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: `platform must be one of ${SUPPORTED_PLATFORMS.join(", ")}` }) };
    }

    const authConfigId = authConfigIdFor(platform);
    const marketplaceUrl = process.env.MARKETPLACE_URL || "";
    const callbackUrl = `${marketplaceUrl}/vendor/integrations?connected=${platform}`;

    const connRequest = await getComposio().connectedAccounts.initiate(memberId, authConfigId, {
      callbackUrl,
    });

    // Persist the connection on the shared vendor_settings row. composio_connection_id
    // doubles as the "is connected" flag the marketplace reads.
    const { error } = await getSupabase()
      .from("vendor_settings")
      .upsert(
        {
          member_id: memberId,
          composio_platform: platform,
          composio_connection_id: connRequest.id,
        },
        { onConflict: "member_id" }
      );
    if (error) throw new Error(`vendor_settings upsert failed: ${error.message}`);

    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ url: connRequest.redirectUrl }),
    };
  } catch (err) {
    console.error("composio-connect error:", err);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: err.message || "Connect failed" }) };
  }
};
