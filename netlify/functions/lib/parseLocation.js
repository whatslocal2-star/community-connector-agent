export async function parseGoogleMapsUrl(url) {
  if (!url || typeof url !== "string") return null;

  let expandedUrl = url.trim();

  // Follow short links (maps.app.goo.gl, goo.gl/maps)
  if (expandedUrl.includes("goo.gl")) {
    try {
      const res = await fetch(expandedUrl, {
        redirect: "follow",
        signal: AbortSignal.timeout(6000),
      });
      expandedUrl = res.url;
    } catch {
      return null;
    }
  }

  // @lat,lng format — most common in place/directions URLs
  const atMatch = expandedUrl.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (atMatch) {
    return { latitude: parseFloat(atMatch[1]), longitude: parseFloat(atMatch[2]) };
  }

  // ?q=lat,lng or &q=lat,lng
  const qMatch = expandedUrl.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (qMatch) {
    return { latitude: parseFloat(qMatch[1]), longitude: parseFloat(qMatch[2]) };
  }

  // ll=lat,lng
  const llMatch = expandedUrl.match(/[?&]ll=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (llMatch) {
    return { latitude: parseFloat(llMatch[1]), longitude: parseFloat(llMatch[2]) };
  }

  return null;
}
