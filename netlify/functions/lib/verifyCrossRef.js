import { GoogleGenerativeAI } from "@google/generative-ai";
import { saveMember } from "./db.js";

// Onboarding-time verification: there is no prior ground truth to match
// against (the user is providing the profile). Instead we ask Gemini to
// cross-reference the contact channels they gave us — do they all
// consistently describe the same business?
//
// Saves profile.ownershipVerification = {
//   verified: boolean,            // confidence >= THRESHOLD
//   method: "cross_ref",
//   confidence: 0..1,
//   reasoning: string,
//   channels: { website, gmaps, instagram, phone },
//   verifiedAt: ISO string
// }

const THRESHOLD = 0.7;

// Member types that have a public-facing identity worth cross-referencing.
// Shoppers don't run a business / public presence, so there's nothing to
// verify against — skip them. (Previously the gate was tangled around the
// rarely-set `businessName` field and special-cased only vendors, which meant
// artists/organizers/influencers with 2+ channels were ALWAYS skipped.)
const VERIFIABLE_TYPES = new Set(["vendor", "artist", "organizer", "influencer"]);

export function shouldCrossRef(profile) {
  if (!profile) return false;
  if (profile.ownershipVerification) return false;        // already verified
  if (!profile.name) return false;                         // need an identity to verify
  if (!VERIFIABLE_TYPES.has(profile.memberType)) return false;
  return countChannels(profile) >= 2;                      // need ≥2 channels to cross-reference
}

function countChannels(profile) {
  let n = 0;
  if (profile.websiteUrl) n++;
  if (profile.googleMapsUrl) n++;
  if (profile.instagramHandle) n++;
  if (profile.businessPhone) n++;
  return n;
}

function buildPrompt(profile) {
  const bizName = profile.businessName || profile.name;
  const channels = {
    website: profile.websiteUrl || null,
    gmaps: profile.googleMapsUrl || null,
    instagram: profile.instagramHandle
      ? `https://instagram.com/${String(profile.instagramHandle).replace(/^@/, "")}`
      : null,
    phone: profile.businessPhone || null,
  };
  const lines = Object.entries(channels)
    .filter(([, v]) => v)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");

  return {
    channels,
    prompt: `You are verifying that a self-reported business profile is consistent across public contact channels.

Business name (as told to us): ${bizName}
${profile.city ? `City: ${profile.city}` : ""}
${profile.businessCategory ? `Category: ${profile.businessCategory}` : ""}

Contact channels they provided:
${lines}

Visit each channel above and check whether they all describe the SAME business. Look for:
- Business name appearing on each channel (allow minor variation)
- Consistent address / city / neighborhood
- Cross-references between channels (e.g. website links to IG, GMaps lists website)
- No obvious contradictions

Return JSON only:
{
  "confidence": 0.0–1.0,
  "reasoning": "one or two sentences explaining the score",
  "consistent_channels": ["website","gmaps", ...],
  "inconsistent_channels": []
}

Score guidance: 0.9+ = strong cross-reference confirmed. 0.7–0.9 = mostly consistent, minor gaps. 0.4–0.7 = mixed evidence. <0.4 = channels appear to describe different businesses or one or more are inaccessible.`,
  };
}

export async function runCrossRefVerify(memberId, profile) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("runCrossRefVerify: GEMINI_API_KEY not set, skipping");
    return null;
  }

  const { channels, prompt } = buildPrompt(profile);

  try {
    const genai = new GoogleGenerativeAI(apiKey);
    const model = genai.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();

    let parsed;
    try {
      const cleaned = text.replace(/^```json\n?/, "").replace(/\n?```$/, "");
      parsed = JSON.parse(cleaned);
    } catch {
      console.warn("runCrossRefVerify: failed to parse Gemini response", text.slice(0, 200));
      return null;
    }

    const confidence = Number(parsed.confidence) || 0;
    const verified = confidence >= THRESHOLD;

    const verification = {
      verified,
      method: "cross_ref",
      confidence,
      reasoning: parsed.reasoning || null,
      consistent_channels: parsed.consistent_channels || [],
      inconsistent_channels: parsed.inconsistent_channels || [],
      channels,
      verifiedAt: new Date().toISOString(),
    };

    await saveMember(memberId, { profileUpdate: { ownershipVerification: verification } });
    return verification;
  } catch (err) {
    console.error("runCrossRefVerify error:", err);
    return null;
  }
}
