import { schedules } from "@trigger.dev/sdk";

// Weekly proactive harvest: pull Oakland businesses from Google Places,
// GPT-enrich, store as members with status="unclaimed". When a real
// owner later signs up, they can claim the profile (claim-profile.js)
// and find connections already waiting for them.
//
// Idempotent — skips any place whose place_id is already in Firestore.

const OAKLAND_CENTER = { lat: 37.8044, lng: -122.2712 };
const RADIUS_METERS = 8000;

const SEED_TYPES = [
  "restaurant",
  "cafe",
  "bar",
  "bakery",
  "store",
  "art_gallery",
  "beauty_salon",
  "book_store",
  "clothing_store",
];

export const harvestOakland = schedules.task({
  id: "harvest-oakland",
  cron: "0 9 * * 0",
  run: async () => {
    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) return { error: "GOOGLE_PLACES_API_KEY missing" };

    const { initializeApp, cert, getApps } = await import("firebase-admin/app");
    const { getFirestore, FieldValue } = await import("firebase-admin/firestore");
    const OpenAI = (await import("openai")).default;
    const { Pinecone } = await import("@pinecone-database/pinecone");

    if (!getApps().length) {
      initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
        }),
      });
    }
    const db = getFirestore();
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const pinecone = process.env.PINECONE_API_KEY
      ? new Pinecone({ apiKey: process.env.PINECONE_API_KEY })
      : null;
    const index = pinecone?.index(process.env.PINECONE_INDEX_NAME || "community-members");

    let scanned = 0;
    let created = 0;
    let skipped = 0;

    for (const type of SEED_TYPES) {
      const places = await nearbySearch(apiKey, OAKLAND_CENTER, RADIUS_METERS, type);
      scanned += places.length;

      for (const place of places) {
        if (!place.place_id) continue;
        const memberId = `gp_${place.place_id}`;

        const existing = await db.collection("members").doc(memberId).get();
        if (existing.exists) { skipped++; continue; }

        const details = await placeDetails(apiKey, place.place_id);
        const merged = { ...place, ...details };
        const profile = await gptEnrich(openai, merged, type);

        await db.collection("members").doc(memberId).set({
          source: "google_places_harvest",
          status: "unclaimed",
          phone: null,
          profile: {
            ...profile,
            memberType: profile.memberType || "vendor",
            placeId: place.place_id,
            city: profile.city || "Oakland",
            googleMapsUrl: details?.url || null,
            latitude: place.geometry?.location?.lat ?? null,
            longitude: place.geometry?.location?.lng ?? null,
            harvestedAt: new Date().toISOString(),
          },
          createdAt: FieldValue.serverTimestamp(),
          lastActiveAt: FieldValue.serverTimestamp(),
        }, { merge: true });

        if (index) {
          try {
            const text = buildProfileText(profile);
            if (text.trim()) {
              const emb = await openai.embeddings.create({
                model: "text-embedding-3-small",
                input: text,
              });
              await index.upsert([{
                id: memberId,
                values: emb.data[0].embedding,
                metadata: {
                  memberType: profile.memberType || "vendor",
                  onboardingComplete: false,
                  unclaimed: true,
                },
              }]);
            }
          } catch (err: any) {
            console.error(`Embed failed for ${memberId}:`, err.message);
          }
        }

        created++;
      }
    }

    return { scanned, created, skipped };
  },
});

async function nearbySearch(apiKey: string, center: { lat: number; lng: number }, radius: number, type: string) {
  const all: any[] = [];
  let pagetoken: string | undefined;
  for (let page = 0; page < 3; page++) {
    const url = new URL("https://maps.googleapis.com/maps/api/place/nearbysearch/json");
    url.searchParams.set("location", `${center.lat},${center.lng}`);
    url.searchParams.set("radius", String(radius));
    url.searchParams.set("type", type);
    url.searchParams.set("key", apiKey);
    if (pagetoken) url.searchParams.set("pagetoken", pagetoken);

    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
    if (!res.ok) break;
    const data: any = await res.json();
    all.push(...(data.results || []));
    if (!data.next_page_token) break;
    pagetoken = data.next_page_token;
    // Google requires a short delay before next_page_token becomes valid.
    await new Promise(r => setTimeout(r, 2200));
  }
  return all;
}

async function placeDetails(apiKey: string, placeId: string) {
  try {
    const url = new URL("https://maps.googleapis.com/maps/api/place/details/json");
    url.searchParams.set("place_id", placeId);
    url.searchParams.set("key", apiKey);
    url.searchParams.set(
      "fields",
      "name,formatted_address,formatted_phone_number,opening_hours,website,editorial_summary,reviews,types,url,price_level"
    );
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data: any = await res.json();
    return data.result;
  } catch {
    return null;
  }
}

const EXTRACTION_PROMPT = `You are extracting a structured community-profile from a Google Places business listing.

Return JSON with ONLY fields you can confidently extract:
- name (string)
- businessName (string)
- businessCategory (string — e.g. "coffee shop", "bookstore")
- businessDescription (string — 1-2 sentences)
- category (string — top-level taxonomy bucket)
- subcategory (string)
- memberType ("vendor" by default)
- vibe (string — the feel from reviews + summary)
- specialties (array of strings)
- services (array of strings)
- neighborhood (string)
- city (string)
- websiteUrl (string)
- businessAddress (string)
- businessPhone (string)
- businessHours (string)
- priceLevel (number 1–4 if known)

Omit any field you can't determine. Never guess. Return valid JSON only.`;

async function gptEnrich(openai: any, place: any, seedType: string) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 800,
      messages: [
        { role: "system", content: EXTRACTION_PROMPT },
        { role: "user", content: `Seed type: ${seedType}\n\n${JSON.stringify(place, null, 2)}` },
      ],
      response_format: { type: "json_object" },
    });
    return JSON.parse(completion.choices[0].message.content);
  } catch {
    return {
      name: place.name,
      businessName: place.name,
      businessCategory: seedType,
      city: "Oakland",
    };
  }
}

function buildProfileText(profile: any) {
  const parts = [];
  if (profile.businessDescription) parts.push(profile.businessDescription);
  if (profile.businessCategory) parts.push(profile.businessCategory);
  if (profile.specialties?.length) parts.push(profile.specialties.join(", "));
  if (profile.services?.length) parts.push(profile.services.join(", "));
  if (profile.vibe) parts.push(profile.vibe);
  if (profile.neighborhood) parts.push(profile.neighborhood);
  if (profile.city) parts.push(profile.city);
  return parts.join(". ");
}
