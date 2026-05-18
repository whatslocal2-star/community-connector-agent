import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  project: "proj_xlqnddtyofcgtvjudspi",
  runtime: "node-22",
  logLevel: "log",
  maxDuration: 600,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 2,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
    },
  },
  dirs: ["trigger"],
});
