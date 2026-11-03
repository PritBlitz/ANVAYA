import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);

/**
 * E2E tests run the production build against the fixture adapter, so they are
 * deterministic and need no backend, GitHub App, or model provider.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, testIgnore: /responsive\.spec\.ts/ },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"] },
      testMatch: /(responsive|homepage)\.spec\.ts/,
    },
    // The desktop journeys again in Gecko and WebKit. CI always runs them; locally set
    // E2E_ALL_BROWSERS=1 (and `npx playwright install firefox webkit`) to include them.
    ...(process.env.CI || process.env.E2E_ALL_BROWSERS
      ? [
          {
            name: "firefox",
            use: { ...devices["Desktop Firefox"] },
            testIgnore: /responsive\.spec\.ts/,
          },
          {
            name: "webkit",
            use: { ...devices["Desktop Safari"] },
            testIgnore: /responsive\.spec\.ts/,
          },
        ]
      : []),
  ],
  webServer: {
    // NEXT_PUBLIC_* values are inlined at build time, so E2E builds its own bundle with
    // fast fixture timings. Set E2E_SKIP_BUILD=1 to reuse an existing E2E build.
    command: `${process.env.E2E_SKIP_BUILD ? "" : "npx next build && "}npx next start --port ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    env: {
      ANVAYA_DIST_DIR: ".next-e2e",
      NEXT_PUBLIC_API_MODE: "fixtures",
      NEXT_PUBLIC_FIXTURE_STAGE_MS: "250",
      NEXT_PUBLIC_FIXTURE_LATENCY_MS: "30",
    },
  },
});
