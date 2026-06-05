import { schedules } from "@trigger.dev/sdk";
import { initObservability, captureError, trackEvent, flushObservability } from "../netlify/functions/lib/observability.js";

const EVENT_DETECTION_PROMPT = `You are scanning scraped web content for event announcements.

Look for anything that looks like an upcoming event: shows, pop-ups, sales, workshops, open mics, markets, meetups, performances, classes, tastings, launches, etc.

For each event found, return a JSON array of objects with:
- title (string)
- date (string — ISO date if parseable, otherwise the raw date text)
- time (string or null)
- location (string or null)
- description (string — 1-2 sentences)
- originalExcerpt (string — the relevant snippet from the source)
- reworded (string — rewritten in a warm, community-first voice for a local platform. Keep it concise, energetic, and inviting. Don't use corporate language.)

If no events are found, return an empty array: []

Return valid JSON only — an array at the top level.`;

export const harvestEvents = schedules.task({
  id: "harvest-events",
  cron: "0 8 * * *",
  run: async () => {
    initObservability({ context: "trigger.harvest-events" });
    const { initializeApp, cert, getApps } = await import("firebase-admin/app");
    const { getFirestore, FieldValue } = await import("firebase-admin/firestore");
    const OpenAI = (await import("openai")).default;

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

    const membersSnap = await db.collection("members")
      .where("profile.eventPostingPlatforms", "!=", null)
      .get();

    let totalEvents = 0;
    let membersChecked = 0;

    for (const memberDoc of membersSnap.docs) {
      const subsSnap = await memberDoc.ref.collection("subscriptions")
        .where("active", "==", true)
        .get();

      if (subsSnap.empty) continue;
      membersChecked++;

      const profile = memberDoc.data().profile || {};
      const memberName = profile.name || memberDoc.id;

      for (const subDoc of subsSnap.docs) {
        const sub = subDoc.data();
        const url = resolveChannelUrl(sub);
        if (!url) continue;

        try {
          const content = await scrapeChannel(url);
          if (!content) continue;

          const events = await detectEvents(openai, content, memberName);
          if (!events.length) continue;

          const batch = db.batch();
          for (const event of events) {
            const ref = db.collection("eventSuggestions").doc();
            batch.set(ref, {
              memberId: memberDoc.id,
              memberName,
              source: { platform: sub.type, url },
              ...event,
              status: "pending",
              createdAt: FieldValue.serverTimestamp(),
            });
          }
          await batch.commit();
          totalEvents += events.length;

          await subDoc.ref.update({
            lastCheckedAt: FieldValue.serverTimestamp(),
          });
        } catch (err) {
          captureError(err, { job: "harvest-events", memberId: memberDoc.id, type: sub.type });
        }
      }
    }

    trackEvent("system", "event_harvest_run", { membersChecked, totalEvents });
    await flushObservability();
    return { membersChecked, totalEvents };
  },
});

function resolveChannelUrl(sub: { type: string; handle?: string; url?: string }): string | null {
  if (sub.url) return sub.url;

  switch (sub.type) {
    case "instagram":
      return sub.handle ? `https://www.instagram.com/${sub.handle.replace("@", "")}/` : null;
    case "eventbrite":
      return sub.handle ? `https://www.eventbrite.com/o/${sub.handle}` : null;
    case "facebook":
      return sub.handle ? `https://www.facebook.com/${sub.handle}/events` : null;
    default:
      return null;
  }
}

async function scrapeChannel(url: string): Promise<string | null> {
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: { Accept: "text/plain" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text.slice(0, 10000);
  } catch {
    return null;
  }
}

async function detectEvents(openai: any, content: string, memberName: string) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 2048,
      messages: [
        { role: "system", content: EVENT_DETECTION_PROMPT },
        { role: "user", content: `Content from ${memberName}'s channel:\n\n${content}` },
      ],
      response_format: { type: "json_object" },
    });

    const raw = JSON.parse(completion.choices[0].message.content);
    const events = Array.isArray(raw) ? raw : raw.events || [];
    return events;
  } catch {
    return [];
  }
}
