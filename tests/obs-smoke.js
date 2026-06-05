// Smoke test: fire one PostHog event + one Sentry error using whatever's in .env.
// Run with: node --env-file=.env tests/obs-smoke.js
import {
  initObservability,
  captureError,
  trackEvent,
  flushObservability,
} from "../netlify/functions/lib/observability.js";

console.log("SENTRY_DSN set:", !!process.env.SENTRY_DSN);
console.log("POSTHOG_API_KEY set:", !!process.env.POSTHOG_API_KEY);
console.log("POSTHOG_HOST:", process.env.POSTHOG_HOST || "(default us.i.posthog.com)");

initObservability({ context: "obs-smoke-test" });

trackEvent("smoke-test-user", "obs_smoke_event", {
  source: "cli",
  timestamp: new Date().toISOString(),
  note: "If you see this in PostHog, server-side analytics is working.",
});
console.log("→ trackEvent fired (obs_smoke_event)");

captureError(new Error("obs-smoke-test: this is an intentional test error"), {
  source: "cli",
  step: "smoke-test",
});
console.log("→ captureError fired");

await flushObservability();
console.log("→ flushed. Check PostHog Activity and Sentry Issues in ~30s.");
process.exit(0);
