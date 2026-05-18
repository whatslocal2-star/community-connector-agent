// Verifies the structured search works against production data.
import { searchMembers } from "../netlify/functions/lib/search.js";

const queries = [
  "family-owned jewelry maker",
  "bar with dance floor",
  "historic Italian restaurant in North Beach",
  "comedy club SF",
  "specialty kite shop Chinatown",
  "vintage record store",
  "art gallery for underrepresented artists",
  "printing services SF",
  "yoga or pilates studio",
];

for (const q of queries) {
  console.log("\n=====", q, "=====");
  const r = await searchMembers({ query: q, limit: 5, parseIntent: true });
  console.log("  intent:", JSON.stringify(r.intent.filters), "→", r.results.length, "results");
  for (const m of r.results.slice(0, 5)) {
    const name = m.profile?.name || m.id;
    console.log(`    ${name.padEnd(36)}`, m.matchedOn?.length ? `[${m.matchedOn.join(" | ")}]` : "");
  }
}
