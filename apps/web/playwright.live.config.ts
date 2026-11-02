import { defineConfig, devices } from "@playwright/test";

/**
 * I-9: the real stack — Next in `http` mode → NestJS API → worker → AI service →
 * GitHub. Nothing is mocked in the browser. Not part of `npm run test:e2e`.
 *
 *   LIVE_BASE_URL   web origin in http mode       (default http://localhost:3002)
 *   LIVE_EMAIL      dev-login account             (default dev@example.test)
 *   LIVE_WORKSPACE  workspace slug                (default dev-workspace)
 *   LIVE_REPO       owner/name, already indexed   (default acme/demo-service)
 *   LIVE_INVITE     optional /invitations/accept#token=… link to join first
 *   LIVE_RUN=1      also run the governed task → PR flow (slow with local models)
 *   LIVE_MODE       inference mode for the run    (default local)
 *   LIVE_TASK       task title for the run
 */
export default defineConfig({
  testDir: "./e2e-live",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  timeout: 90 * 60_000,
  expect: { timeout: 30_000 },
  use: {
    ...devices["Desktop Chrome"],
    baseURL: process.env.LIVE_BASE_URL ?? "http://localhost:3002",
    trace: "retain-on-failure",
  },
});
