import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Strict whitelist — anything outside this list goes in semantic, not filters.
const ALLOWED_FILTER_KEYS = [
  "memberType", "category", "subcategory", "city", "neighborhood",
  "priceMin", "priceMax", "product",
  "amenities", "atmosphere", "favoriteTeams",
  "acceptsEBT", "acceptsCash", "acceptsCrypto",
  "wheelchairAccessible", "freeParking",
  "openLate", "open24Hours", "openWeekends",
  "veganOptions", "vegetarianOptions", "glutenFree", "halalCertified", "kosher", "byob", "fullBar",
  "sportsBar", "watchParties",
];

const VENDOR_TAXONOMY = {
  "Food & Beverage": ["Restaurant", "Café", "Bakery", "Food Truck", "Bar", "Catering", "Juice Bar", "Desserts"],
  "Retail": ["Clothing", "Accessories", "Beauty & Cosmetics", "Home Goods", "Books", "Flowers", "Gifts"],
  "Health & Wellness": ["Gym", "Yoga Studio", "Spa", "Salon", "Nutrition", "Massage", "Mental Health"],
  "Services": ["Photography", "Videography", "Cleaning", "Auto", "Printing", "Event Rental", "Consulting"],
  "Arts & Crafts": ["Gallery", "Jewelry", "Pottery", "Handmade Goods", "Candles", "Textiles", "Murals"],
};

const TAXONOMY_BLOCK = Object.entries(VENDOR_TAXONOMY)
  .map(([cat, subs]) => `  - ${cat}: ${subs.join(", ")}`)
  .join("\n");

const INTENT_PROMPT = `You are parsing a local-search query for a community marketplace.

Return a JSON object: { semantic, filters, excludes, intent }.

ABSOLUTE RULES:
- "filters" and "excludes" may ONLY contain keys from this exact list — NO others:
  ${ALLOWED_FILTER_KEYS.join(", ")}
- NEVER invent filter keys like "dive bar", "live music", "record store", "vintage" — those go in semantic OR map to one of the keys above.
- A NL phrase like "live music" → amenities: ["live music"]. Not a top-level key.
- A NL phrase like "dive bar", "lively", "cozy", "intimate", "upscale" → atmosphere: [...].
- A NL phrase like "outdoor seating", "wifi", "fireplace", "dance floor", "tv" → amenities: [...].
- "category" must be one of (or omit): ${Object.keys(VENDOR_TAXONOMY).join(" | ")}
- "subcategory" must be one of (and only when category is also set):
${TAXONOMY_BLOCK}
- If unsure whether something is a category or subcategory, prefer subcategory ONLY if it matches the list exactly. Otherwise put the phrase in semantic.
- Booleans only when the user explicitly invokes that exact attribute (e.g. "vegan options" → veganOptions:true). Don't infer.
- Omit any key you can't confidently fill. Empty filters is fine — the semantic side handles the rest.

OUTPUT FIELDS:
- semantic: the meaning part of the query (vibe, style, who they are). Strip out filter-able bits BUT keep them in semantic too if it makes the embedding richer.
- filters / excludes: as above
- intent: "find" | "vibe" | "compare" | "recommend"

EXAMPLES:

"buzz cut under $15 in Chinatown with a TV"
→ {"semantic":"buzz cut barbershop","filters":{"neighborhood":"chinatown","product":"buzz cut","priceMax":15,"amenities":["tv"]},"intent":"find"}

"historic dive bar in North Beach with live music"
→ {"semantic":"historic dive bar live music","filters":{"neighborhood":"north beach","atmosphere":["dive bar","historic"],"amenities":["live music"]},"intent":"find"}

"family-owned jewelry maker"
→ {"semantic":"family-owned jewelry maker","filters":{"category":"Arts & Crafts","subcategory":"Jewelry"},"intent":"find"}

"vintage record store"
→ {"semantic":"vintage record store records vinyl","filters":{"category":"Retail"},"intent":"find"}

"bar with dance floor"
→ {"semantic":"bar with dance floor lively","filters":{"category":"Food & Beverage","subcategory":"Bar","amenities":["dance floor"]},"intent":"find"}

"49ers bar open late with a fireplace SoMa"
→ {"semantic":"sports bar 49ers fireplace","filters":{"neighborhood":"soma","sportsBar":true,"openLate":true,"favoriteTeams":["sf 49ers"],"amenities":["fireplace"]},"intent":"find"}

"vegan halal options open Sunday Oakland"
→ {"semantic":"vegan halal","filters":{"city":"oakland","veganOptions":true,"halalCertified":true,"openWeekends":true},"intent":"find"}

"coffee shop with good vibes for working, not loud, not a chain"
→ {"semantic":"quiet independent coffee shop for working","filters":{"category":"Food & Beverage","subcategory":"Café","atmosphere":["quiet"]},"excludes":{"atmosphere":["lively","loud"]},"intent":"vibe"}

"muralist in Oakland for community events"
→ {"semantic":"muralist community events","filters":{"memberType":"artist","city":"oakland"},"intent":"find"}`;

function pickAllowedKeys(obj) {
  if (!obj || typeof obj !== "object") return {};
  const out = {};
  for (const k of ALLOWED_FILTER_KEYS) if (obj[k] !== undefined) out[k] = obj[k];
  // Validate category/subcategory against canonical taxonomy — drop inventions.
  if (out.category && !VENDOR_TAXONOMY[out.category]) {
    delete out.category; delete out.subcategory;
  } else if (out.subcategory && out.category && !VENDOR_TAXONOMY[out.category].includes(out.subcategory)) {
    delete out.subcategory;
  }
  return out;
}

export async function parseSearchIntent(query) {
  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 400,
      messages: [
        { role: "system", content: INTENT_PROMPT },
        { role: "user", content: query },
      ],
      response_format: { type: "json_object" },
    });
    const parsed = JSON.parse(completion.choices[0].message.content);
    return {
      semantic: parsed.semantic || query,
      filters: pickAllowedKeys(parsed.filters),  // strip invented keys
      excludes: pickAllowedKeys(parsed.excludes),
      intent: parsed.intent || "find",
    };
  } catch (err) {
    console.error("parseSearchIntent error:", err);
    return { semantic: query, filters: {}, excludes: {}, intent: "find" };
  }
}
