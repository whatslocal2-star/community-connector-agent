import { loadAllMembers } from "./lib/db.js";
import { upsertMemberVector } from "./lib/vectorSearch.js";
import { isAdminAuthorized, unauthorized } from "./lib/adminAuth.js";

export const handler = async (event) => {
  if (!isAdminAuthorized(event)) return unauthorized();

  const members = await loadAllMembers(500);
  const results = { ok: 0, skipped: 0, errors: [] };

  for (const member of members) {
    if (!member.profile || Object.keys(member.profile).length === 0) {
      results.skipped++;
      continue;
    }
    try {
      await upsertMemberVector(member.id, member.profile);
      results.ok++;
    } catch (err) {
      results.errors.push({ id: member.id, error: err.message });
    }
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(results),
  };
};
