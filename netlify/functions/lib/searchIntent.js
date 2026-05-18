import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const INTENT_PROMPT = `You are parsing a local-search query for a community marketplace (vendors, artists, organizers, shoppers, influencers).

Return a JSON object with:
- semantic: string — the part of the query that should be matched by meaning (vibe, products, services, themes). Keep it concise; strip out filter-y bits.
- filters: object with any of these keys you can confidently infer:
  - memberType: "vendor" | "artist" | "organizer" | "shopper" | "influencer"
  - category: string
  - subcategory: string
  - city: string
  - neighborhood: string
  - priceMax: number (USD)
  - priceMin: number (USD)
  - amenities: string[] (lowercase, e.g. ["tv", "outdoor seating", "dog friendly", "fireplace", "wifi", "pool table", "live music"])
  - atmosphere: string[] (lowercase, e.g. ["quiet", "lively", "intimate", "dive bar"])
  - product: string — a specific product or service the user is searching for (e.g. "buzz cut", "fade", "matcha latte"). Use this when the user mentions a specific menu item, especially with a price.
  - acceptsCrypto: boolean
  - acceptsCash: boolean
  - acceptsEBT: boolean
  - wheelchairAccessible: boolean
  - freeParking: boolean
  - openLate: boolean
  - open24Hours: boolean
  - openWeekends: boolean
  - veganOptions: boolean
  - vegetarianOptions: boolean
  - glutenFree: boolean
  - halalCertified: boolean
  - kosher: boolean
  - byob: boolean
  - fullBar: boolean
  - sportsBar: boolean
  - watchParties: boolean
  - favoriteTeams: string[] (e.g. ["sf 49ers", "warriors"])
- excludes: object (same shape as filters) — things the user said NOT to include
- intent: "find" | "vibe" | "compare" | "recommend"

Omit any key you can't confidently infer. Return valid JSON only.

Examples:
"buzz cut under $15 in Chinatown with a TV"
→ {"semantic":"buzz cut barbershop","filters":{"neighborhood":"chinatown","product":"buzz cut","priceMax":15,"amenities":["tv"]},"intent":"find"}

"49ers bar open late with a fireplace SoMa"
→ {"semantic":"sports bar 49ers fireplace","filters":{"neighborhood":"soma","sportsBar":true,"openLate":true,"favoriteTeams":["sf 49ers"],"amenities":["fireplace"]},"intent":"find"}

"vegan halal options open Sunday Oakland"
→ {"semantic":"vegan halal","filters":{"city":"oakland","veganOptions":true,"halalCertified":true,"openWeekends":true},"intent":"find"}

"coffee shop with good vibes for working, not loud, not a chain"
→ {"semantic":"quiet independent coffee shop for working","filters":{"atmosphere":["quiet"]},"excludes":{"atmosphere":["lively","loud"]},"intent":"vibe"}

"muralist in Oakland for community events"
→ {"semantic":"muralist community events","filters":{"memberType":"artist","city":"oakland"},"intent":"find"}`;

export async function parseSearchIntent(query) {
  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 300,
      messages: [
        { role: "system", content: INTENT_PROMPT },
        { role: "user", content: query },
      ],
      response_format: { type: "json_object" },
    });
    const parsed = JSON.parse(completion.choices[0].message.content);
    return {
      semantic: parsed.semantic || query,
      filters: parsed.filters || {},
      excludes: parsed.excludes || {},
      intent: parsed.intent || "find",
    };
  } catch (err) {
    console.error("parseSearchIntent error:", err);
    return { semantic: query, filters: {}, excludes: {}, intent: "find" };
  }
}
