import { loadAllMembers, saveMember } from "./lib/db.js";
import { parseGoogleMapsUrl } from "./lib/parseLocation.js";
import { isAdminAuthorized, unauthorized } from "./lib/adminAuth.js";

export const handler = async (event) => {
  if (!isAdminAuthorized(event)) return unauthorized();

  const members = await loadAllMembers(500);
  const needsBackfill = members.filter(
    (m) => m.profile?.googleMapsUrl && !m.profile?.latitude
  );

  const results = [];
  for (const m of needsBackfill) {
    const coords = await parseGoogleMapsUrl(m.profile.googleMapsUrl);
    if (coords) {
      await saveMember(m.id, { profileUpdate: coords });
      results.push({ id: m.id, name: m.profile.name, ...coords });
    } else {
      results.push({ id: m.id, name: m.profile.name, error: "could not parse" });
    }
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ backfilled: results.length, results }),
  };
};
