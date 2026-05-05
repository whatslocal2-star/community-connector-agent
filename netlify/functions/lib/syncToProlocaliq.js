const BUSINESS_MEMBER_TYPES = new Set(["vendor", "artist", "organizer"]);

function isReadyToSync(profile) {
  return (
    profile.email &&
    profile.name &&
    profile.memberType &&
    !profile.prolocaliqSynced
  );
}

export async function syncToProlocaliq(memberId, profile) {
  const prolocaliqUrl = process.env.PROLOCALIQ_URL;
  const syncToken = process.env.CC_SYNC_TOKEN;

  if (!prolocaliqUrl || !syncToken) {
    console.warn("syncToProlocaliq: missing PROLOCALIQ_URL or CC_SYNC_TOKEN — skipping");
    return null;
  }

  if (!isReadyToSync(profile)) return null;

  try {
    const res = await fetch(`${prolocaliqUrl}/api/integrations/community-connector/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${syncToken}`,
      },
      body: JSON.stringify({ memberId, profile }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`syncToProlocaliq: HTTP ${res.status} — ${text}`);
      return null;
    }

    return await res.json();
  } catch (err) {
    console.error("syncToProlocaliq error:", err);
    return null;
  }
}

export { isReadyToSync, BUSINESS_MEMBER_TYPES };
