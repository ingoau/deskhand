import { defineConfig, devices } from "@playwright/test";

/**
 * E2E against the production bundle served by `vite preview` with the mock API, under a sub-path
 * (like the manager with DESKHAND_BASE_PATH=/deskhand). Run inside the Playwright image:
 *   DEV_IMAGE=mcr.microsoft.com/playwright:v1.64.1-noble scripts/dev pnpm --filter @deskhand/dashboard e2e
 */
const PORT = Number(process.env.E2E_PORT ?? 17110);
const BASE = "/deskhand/";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1, // one shared mock server; each test resets it
  retries: 0,
  reporter: [["list"]],
  timeout: 30_000,
  expect: { timeout: 7_000 },
  use: {
    baseURL: `http://127.0.0.1:${PORT}${BASE}`,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1320, height: 740 } } },
    {
      name: "mobile",
      use: {
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        userAgent: devices["Pixel 7"].userAgent,
      },
    },
  ],
  webServer: {
    command: `pnpm exec vite build --logLevel warn && MOCK=1 MOCK_BASE=${BASE} pnpm exec vite preview --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}${BASE}`,
    reuseExistingServer: !!process.env.E2E_REUSE,
    timeout: 120_000,
  },
});
