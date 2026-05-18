// Single entry point for Sentry + PostHog. No-ops when env vars are unset
// so local dev and tests don't need keys configured.

import * as Sentry from "@sentry/node";
import { PostHog } from "posthog-node";

let sentryReady = false;
let posthog = null;

export function initObservability({ context = "netlify-function" } = {}) {
  if (!sentryReady && process.env.SENTRY_DSN) {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.SENTRY_ENVIRONMENT || process.env.CONTEXT || "production",
      tracesSampleRate: 0,
      release: process.env.COMMIT_REF || undefined,
    });
    Sentry.setTag("service", context);
    sentryReady = true;
  }

  if (!posthog && process.env.POSTHOG_API_KEY) {
    posthog = new PostHog(process.env.POSTHOG_API_KEY, {
      host: process.env.POSTHOG_HOST || "https://us.i.posthog.com",
      flushAt: 1,
      flushInterval: 0,
    });
  }
}

export function captureError(err, extra = {}) {
  try {
    console.error("[observability]", err?.message || err, extra);
    if (sentryReady) {
      Sentry.withScope((scope) => {
        for (const [k, v] of Object.entries(extra)) scope.setExtra(k, v);
        Sentry.captureException(err);
      });
    }
  } catch {
    // swallow — observability must never throw
  }
}

export function trackEvent(distinctId, event, properties = {}) {
  try {
    if (!posthog || !distinctId) return;
    posthog.capture({ distinctId, event, properties });
  } catch {
    // swallow
  }
}

export async function flushObservability() {
  try {
    if (posthog) await posthog.flush();
    if (sentryReady) await Sentry.flush(2000);
  } catch {
    // swallow
  }
}
