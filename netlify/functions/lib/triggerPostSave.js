import { tasks } from "@trigger.dev/sdk";

// Enqueue the post-save background pipeline (subscriptions, location parse,
// cross-reference verification, enrichment) as a Trigger.dev task. These used
// to run as fire-and-forget promises inside the Netlify
// function, which terminates as soon as the response is returned — so any
// network-bound step (Gemini, Jina, Google Places, OpenAI) was routinely
// killed mid-flight. Running them in Trigger.dev guarantees completion.
//
// Requires TRIGGER_SECRET_KEY in the Netlify environment. If it's missing
// (e.g. local dev without trigger), we log and move on rather than failing
// the chat response.
export async function enqueuePostSave(memberId, profileUpdate, channel) {
  try {
    await tasks.trigger("post-save-pipeline", {
      memberId,
      profileUpdate: profileUpdate ?? null,
      channel,
    });
  } catch (err) {
    console.error("enqueuePostSave error:", err.message || err);
  }
}
