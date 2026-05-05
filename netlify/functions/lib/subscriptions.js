const PLATFORM_HANDLE_MAP = {
  instagram: "instagramHandle",
  facebook: "facebookUrl",
  eventbrite: "eventbriteUrl",
  website: "websiteUrl",
  bandsintown: "bandsintownUrl",
  songkick: "songkickUrl",
  meetup: "meetupUrl",
  tiktok: "tiktokHandle",
};

export function buildSubscriptionsFromProfile(profile) {
  const platforms = profile.eventPostingPlatforms;
  if (!Array.isArray(platforms) || !platforms.length) return [];

  const subs = [];
  for (const raw of platforms) {
    const platform = raw.toLowerCase().trim();
    const handleField = PLATFORM_HANDLE_MAP[platform];
    const handle = handleField ? profile[handleField] : null;

    subs.push({
      type: platform,
      handle: handle || null,
      url: handle && platform !== "instagram" && platform !== "tiktok" ? handle : null,
    });
  }
  return subs;
}

export function hasNewSubscriptionData(profileUpdate) {
  return Array.isArray(profileUpdate?.eventPostingPlatforms) && profileUpdate.eventPostingPlatforms.length > 0;
}
