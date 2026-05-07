import OpenAI from "openai";

let _openai = null;
function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

const EXTRACTION_PROMPT = `You are extracting structured business/creator profile data from scraped web content.

Return a JSON object with ONLY the fields you can confidently extract. Use these field names:
- businessName (string)
- businessCategory (string — e.g. "coffee shop", "tattoo studio", "DJ", "bakery")
- businessDescription (string — 1-2 sentence summary of what they do)
- businessHours (string — e.g. "Mon-Fri 8am-5pm, Sat 9am-3pm")
- businessAddress (string)
- businessPhone (string)
- city (string)
- neighborhood (string)
- services (array of strings — what they offer)
- menuHighlights (array of strings — notable items if restaurant/cafe/bar)
- reviewsSummary (string — 1 sentence summary of review sentiment if available)
- instagramHandle (string — without @)
- facebookUrl (string)
- websiteUrl (string)
- eventbriteUrl (string)
- shareTypes (array — what they share: "deals", "events", "new arrivals", etc.)
- vibe (string — the overall feel/personality)
- specialties (array of strings)

Omit any field you can't determine. Never guess. Return valid JSON only.`;

export async function scrapeWebsite(url) {
  try {
    const jinaUrl = `https://r.jina.ai/${url}`;
    const res = await fetch(jinaUrl, {
      headers: { Accept: "text/plain" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text.slice(0, 8000);
  } catch (err) {
    console.error("Jina scrape error:", err.message);
    return null;
  }
}

export async function searchGooglePlaces(query) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch(
      `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${apiKey}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const place = data.results?.[0];
    if (!place) return null;

    let details = null;
    if (place.place_id) {
      const detailRes = await fetch(
        `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place.place_id}&fields=name,formatted_address,formatted_phone_number,opening_hours,website,editorial_summary,reviews,types&key=${apiKey}`,
        { signal: AbortSignal.timeout(10000) }
      );
      if (detailRes.ok) {
        const detailData = await detailRes.json();
        details = detailData.result;
      }
    }

    return {
      name: details?.name || place.name,
      address: details?.formatted_address || place.formatted_address,
      phone: details?.formatted_phone_number,
      website: details?.website,
      hours: details?.opening_hours?.weekday_text?.join(", "),
      summary: details?.editorial_summary?.overview,
      rating: place.rating,
      totalReviews: place.user_ratings_total,
      types: details?.types || place.types,
      reviews: details?.reviews?.slice(0, 3).map(r => r.text).join(" | "),
    };
  } catch (err) {
    console.error("Google Places error:", err.message);
    return null;
  }
}

export async function extractProfileFromContent(scrapedContent) {
  const openai = getOpenAI();

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 1024,
    messages: [
      { role: "system", content: EXTRACTION_PROMPT },
      { role: "user", content: scrapedContent },
    ],
    response_format: { type: "json_object" },
  });

  try {
    return JSON.parse(completion.choices[0].message.content);
  } catch {
    return null;
  }
}

export async function enrichProfile(profile) {
  const sources = [];

  const websiteUrl = profile.websiteUrl || profile.googleMapsUrl;
  const businessName = profile.businessName || profile.name;
  const city = profile.city || profile.neighborhood;

  if (websiteUrl) {
    const content = await scrapeWebsite(websiteUrl);
    if (content) sources.push(`--- Website content from ${websiteUrl} ---\n${content}`);
  }

  if (businessName && city) {
    const places = await searchGooglePlaces(`${businessName} ${city}`);
    if (places) {
      sources.push(`--- Google Places data ---\n${JSON.stringify(places, null, 2)}`);

      if (places.website && !websiteUrl) {
        const content = await scrapeWebsite(places.website);
        if (content) sources.push(`--- Website content from ${places.website} ---\n${content}`);
      }
    }
  }

  if (!sources.length) return null;

  return extractProfileFromContent(sources.join("\n\n"));
}

export function hasEnrichableData(profileUpdate) {
  if (!profileUpdate) return false;
  const enrichKeys = [
    "websiteUrl", "googleMapsUrl", "shopifyUrl", "businessUrl",
    "eventbriteUrl", "facebookUrl", "googleMapsUrl",
  ];
  return enrichKeys.some(k => profileUpdate[k]);
}
