import { Composio } from "@composio/core";

// Single Composio client. Auth-config ids are created once per platform in
// the Composio dashboard (Auth Configs → New) and supplied via env. We scope
// every connection and tool call by `userId = marketplace memberId`, so a
// vendor's connected store is always resolvable from their member id without
// storing a separate Composio handle.
let composio = null;

export function getComposio() {
  if (!composio) {
    const apiKey = process.env.COMPOSIO_API_KEY;
    if (!apiKey) throw new Error("COMPOSIO_API_KEY is required");
    composio = new Composio({ apiKey });
  }
  return composio;
}

const AUTH_CONFIG_ENV = {
  shopify: "COMPOSIO_SHOPIFY_AUTH_CONFIG_ID",
  square: "COMPOSIO_SQUARE_AUTH_CONFIG_ID",
};

export const SUPPORTED_PLATFORMS = Object.keys(AUTH_CONFIG_ENV);

export function authConfigIdFor(platform) {
  const envKey = AUTH_CONFIG_ENV[platform];
  const id = envKey && process.env[envKey];
  if (!id) {
    throw new Error(`No Composio auth config id configured for platform "${platform}" (set ${envKey})`);
  }
  return id;
}

// Composio's tool slugs per platform. Confirm exact argument/return schemas in
// the dashboard (Auth Configs → Tools & Triggers) before relying on a field.
export const TOOL_SLUGS = {
  shopify: { list: "SHOPIFY_LIST_ALL_PRODUCTS", createOrder: "SHOPIFY_CREATE_ORDER" },
  square: { list: "SQUARE_LIST_CATALOG", createOrder: "SQUARE_CREATE_ORDER" },
};

// composio.tools.execute returns { data, successful, error } across recent SDK
// versions. Normalize to throw on failure and return the raw provider payload.
export async function runTool(slug, memberId, args = {}) {
  const result = await getComposio().tools.execute(slug, { userId: memberId, arguments: args });
  if (result && result.successful === false) {
    throw new Error(`Composio ${slug} failed: ${result.error || "unknown error"}`);
  }
  return result?.data ?? result;
}
