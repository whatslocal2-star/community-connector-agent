// Business-ownership verification engine.
// Ported from community-marketplace lib/vendor-verify.ts. Single source of
// truth; both apps call /verify on the connector-agent.

import { GoogleGenerativeAI } from "@google/generative-ai";

export const VERIFICATION_METHODS = ["phone", "google_maps", "website_email", "instagram", "gemini"];

// ─── Google Places API ───────────────────────────────────────────────────────

function extractPlaceSearchQuery(url) {
  try {
    const decoded = decodeURIComponent(url);
    const placeMatch = decoded.match(/\/maps\/place\/([^/@]+)/);
    if (placeMatch) return placeMatch[1].replace(/\+/g, " ");
    const searchMatch = decoded.match(/\/maps\/search\/([^/@?]+)/);
    if (searchMatch) return searchMatch[1].replace(/\+/g, " ");
    const u = new URL(url);
    return u.searchParams.get("q");
  } catch {
    return null;
  }
}

// A raw Place ID (e.g. "ChIJ...") — Places API resource id, not a URL.
function extractPlaceId(input) {
  const s = String(input || "").trim();
  if (/^ChIJ[\w-]+$/.test(s)) return s;
  // Some Maps URLs embed the place id as ...!1s0x...:0x... or ?place_id=...
  try {
    const u = new URL(s);
    const pid = u.searchParams.get("place_id");
    if (pid) return pid;
  } catch {
    /* not a URL */
  }
  return null;
}

// Resolve a Maps URL, Place ID, or free-text query to a single place's
// identifying fields via the Places API. Returns null when unresolvable.
async function resolvePlace(input) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return null;

  const fieldMask = "places.id,places.displayName,places.nationalPhoneNumber,places.internationalPhoneNumber";
  const placeId = extractPlaceId(input);

  // Direct Place ID lookup is exact; otherwise fall back to text search.
  if (placeId) {
    const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
      headers: {
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "id,displayName,nationalPhoneNumber,internationalPhoneNumber",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const place = await res.json();
    return {
      id: place.id ?? placeId,
      name: place.displayName?.text ?? null,
      phone: place.nationalPhoneNumber ?? place.internationalPhoneNumber ?? null,
    };
  }

  const searchText = extractPlaceSearchQuery(input) || String(input || "").trim();
  if (!searchText) return null;
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": fieldMask,
    },
    body: JSON.stringify({ textQuery: searchText }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const place = data.places?.[0];
  if (!place) return null;
  return {
    id: place.id ?? null,
    name: place.displayName?.text ?? null,
    phone: place.nationalPhoneNumber ?? place.internationalPhoneNumber ?? null,
  };
}

async function fetchPlacePhone(googleMapsUrl) {
  const place = await resolvePlace(googleMapsUrl);
  return place?.phone ?? null;
}

function normalizePhone(phone) {
  const digits = (phone || "").replace(/\D/g, "");
  // Treat a US 11-digit number (leading country code "1") the same as its
  // 10-digit form, so a profile stored as "+1 510-…" matches a user who
  // types the bare 10-digit number.
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

function normalizeName(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// ─── Firecrawl ───────────────────────────────────────────────────────────────

async function scrapeWebsiteEmails(websiteUrl) {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) return [];

  const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ url: websiteUrl, formats: ["markdown"], onlyMainContent: false }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return [];
  const data = await res.json();
  const text = data.data?.markdown ?? "";
  const emails = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) ?? [];
  return [...new Set(emails.map((e) => e.toLowerCase()))];
}

// ─── Gemini fallback ─────────────────────────────────────────────────────────

async function verifyWithGemini(claimedValue, profile) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { verified: false, reasoning: "Gemini not configured" };

  const genai = new GoogleGenerativeAI(apiKey);
  const model = genai.getGenerativeModel({ model: "gemini-2.0-flash" });

  const links = [
    profile.googleMapsUrl && `Google Maps: ${profile.googleMapsUrl}`,
    profile.websiteUrl && `Website: ${profile.websiteUrl}`,
    profile.instagramHandle && `Instagram: https://instagram.com/${String(profile.instagramHandle).replace(/^@/, "")}`,
  ].filter(Boolean).join("\n");

  const prompt = `You are verifying whether someone is associated with a business.

Business name: ${profile.businessName ?? profile.name ?? "unknown"}
Business links:
${links}

The person provided: "${claimedValue}"

Determine if "${claimedValue}" appears as a contact point (phone number, email, or Instagram handle) for this business by checking the links above.

Respond with JSON only: { "verified": true/false, "reasoning": "one sentence" }`;

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  try {
    const cleaned = text.replace(/^```json\n?/, "").replace(/\n?```$/, "");
    return JSON.parse(cleaned);
  } catch {
    return { verified: false, reasoning: text };
  }
}

// ─── Main entry point ────────────────────────────────────────────────────────

export async function verifyBusinessOwnership(method, claimedValue, profile) {
  if (method === "instagram") {
    const handle = String(profile.instagramHandle ?? "").replace(/^@/, "").toLowerCase();
    const claimed = String(claimedValue).replace(/^@/, "").toLowerCase();
    return {
      verified: handle !== "" && handle === claimed,
      method: "instagram",
      evidence: { onFile: handle, claimed },
    };
  }

  if (method === "phone") {
    const onFile = normalizePhone(profile.businessPhone);
    const claimed = normalizePhone(claimedValue);

    if (onFile && onFile === claimed) {
      return { verified: true, method: "phone", evidence: { source: "profile", onFile, claimed } };
    }
    if (profile.googleMapsUrl) {
      const livePhone = await fetchPlacePhone(profile.googleMapsUrl);
      if (livePhone) {
        const liveNorm = normalizePhone(livePhone);
        if (liveNorm === claimed) {
          return { verified: true, method: "phone", evidence: { source: "places_api", livePhone, claimed } };
        }
      }
    }
    return { verified: false, method: "phone", evidence: { onFile, claimed } };
  }

  if (method === "google_maps") {
    const resolved = await resolvePlace(claimedValue);
    if (!resolved) {
      return { verified: false, method: "google_maps", evidence: { claimed: claimedValue, reason: "could not resolve listing" } };
    }

    // The harvested doc id is `gp_<place_id>`; that's the strongest anchor.
    const onFilePlaceId = profile.placeId || profile.place_id || null;
    if (onFilePlaceId && resolved.id && onFilePlaceId === resolved.id) {
      return { verified: true, method: "google_maps", evidence: { matchedOn: "place_id", placeId: resolved.id } };
    }

    // Otherwise confirm the resolved listing is the same business by phone or name.
    const onFile = await resolvePlace(profile.googleMapsUrl);
    if (onFile) {
      if (onFile.id && resolved.id && onFile.id === resolved.id) {
        return { verified: true, method: "google_maps", evidence: { matchedOn: "place_id", placeId: resolved.id } };
      }
      const phoneA = normalizePhone(onFile.phone);
      const phoneB = normalizePhone(resolved.phone);
      if (phoneA && phoneA === phoneB) {
        return { verified: true, method: "google_maps", evidence: { matchedOn: "phone", phone: phoneB } };
      }
      const nameA = normalizeName(onFile.name);
      const nameB = normalizeName(resolved.name);
      if (nameA && nameA === nameB) {
        return { verified: true, method: "google_maps", evidence: { matchedOn: "name", name: nameB } };
      }
    }
    return {
      verified: false,
      method: "google_maps",
      evidence: { claimed: claimedValue, resolved: { name: resolved.name, phone: resolved.phone } },
    };
  }

  if (method === "website_email") {
    const claimed = String(claimedValue).toLowerCase().trim();
    if (profile.websiteUrl) {
      const emails = await scrapeWebsiteEmails(profile.websiteUrl);
      if (emails.includes(claimed)) {
        return { verified: true, method: "website_email", evidence: { found: emails, claimed } };
      }
    }
    return { verified: false, method: "website_email", evidence: { claimed } };
  }

  if (method === "gemini") {
    const { verified, reasoning } = await verifyWithGemini(claimedValue, profile);
    return { verified, method: "gemini", evidence: { claimed: claimedValue, reasoning } };
  }

  return { verified: false, method, evidence: {} };
}

export function availableVerificationMethods(profile) {
  const methods = [];
  if (profile.businessPhone || profile.googleMapsUrl) methods.push("phone");
  if (profile.googleMapsUrl || profile.placeId || profile.place_id) methods.push("google_maps");
  if (profile.websiteUrl) methods.push("website_email");
  if (profile.instagramHandle) methods.push("instagram");
  methods.push("gemini");
  return methods;
}
