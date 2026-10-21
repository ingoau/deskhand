import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * E2E against the real manager (packages/manager) serving the production dashboard under /deskhand.
 * An MCP SDK client in the tests plays the agent.
 *
 *   E2E_RUNTIME=fake   (default) DESKHAND_RUNTIME=fake: in-process fake desktops, no Docker. Fast, CI-able.
 *   E2E_RUNTIME=docker real desktops from E2E_DESKTOP_IMAGE (default deskhand-desktop:dev); needs the Docker socket.
 *
 * Run inside the Playwright image (manager and dashboard are built by the web server command):
 *   DEV_IMAGE=mcr.microsoft.com/playwright:v1.64.1-noble scripts/dev pnpm --filter @deskhand/dashboard e2e:real
 *   DEV_DOCKER=1 DEV_IMAGE=mcr.microsoft.com/playwright:v1.64.1-noble scripts/dev pnpm --filter @deskhand/dashboard e2e:docker
 *
 * Everything Docker-side is labelled owner=deskhand-dev with its own instance label, network and container prefix,
 * and removed by the global teardown.
 */
const runtime = process.env.E2E_RUNTIME === "docker" ? "docker" : "fake";
const PORT = Number(process.env.E2E_PORT ?? (runtime === "docker" ? 17621 : 17620));
const BASE = "/deskhand";
const repo = path.resolve(import.meta.dirname, "../..");
const dataDir = path.join(repo, "tmp", `e2e-real-${runtime}`);
const instance = `e2e-dash-${runtime}`;

const network = `deskhand-e2e-dash-${runtime}`;

const managerEnv: Record<string, string> = {
  DESKHAND_RUNTIME: runtime,
  DESKHAND_BIND: `127.0.0.1:${PORT}`,
  DESKHAND_BASE_PATH: BASE,
  DESKHAND_DATA_DIR: dataDir,
  DESKHAND_LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? "warn",
  DESKHAND_MAX_DESKTOPS: "4",
  DESKHAND_HEALTH_INTERVAL: "1s",
  DESKHAND_STATS_INTERVAL: "2s",
  DESKHAND_REQUEST_HUMAN_TIMEOUT: "10m",
  ...(runtime === "fake"
    ? { DESKHAND_FAKE_PORTS: "17660-17689", DESKHAND_FAKE_LOCK_WAIT_MS: "4000" }
    : {
        DESKHAND_DESKTOP_IMAGE: process.env.E2E_DESKTOP_IMAGE ?? "deskhand-desktop:dev",
        DESKHAND_NETWORK: network,
        DESKHAND_OWNER_LABEL: "deskhand-dev",
        DESKHAND_INSTANCE: instance,
        DESKHAND_CONTAINER_PREFIX: `deskhand-${instance}-`,
        DESKHAND_START_TIMEOUT: "90s",
      }),
};
// Read by global setup/teardown and the tests (workers load this config too).
process.env.E2E_URL = `http://127.0.0.1:${PORT}${BASE}`;
process.env.E2E_DATA_DIR = dataDir;
process.env.E2E_RUNTIME = runtime;
process.env.E2E_NETWORK = network;

export default defineConfig({
  testDir: "e2e-real",
  fullyParallel: false,
  workers: 1, // one manager; tests share it (each cleans up its own desktops)
  retries: 0,
  reporter: [["list"]],
  timeout: runtime === "docker" ? 180_000 : 60_000,
  expect: { timeout: runtime === "docker" ? 20_000 : 8_000 },
  globalSetup: "./e2e-real/global-setup.ts",
  globalTeardown: "./e2e-real/global-teardown.ts",
  outputDir: `test-results/real-${runtime}`,
  use: {
    baseURL: `http://127.0.0.1:${PORT}${BASE}/`,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", testIgnore: /phone\.spec\.ts/, use: { ...devices["Desktop Chrome"], viewport: { width: 1320, height: 800 } } },
    {
      name: "mobile",
      testMatch: /(phone|screenshots)\.spec\.ts/,
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
    // Builds the dashboard and the manager, starts the manager on a fresh data dir.
    command: [
      `rm -rf ${dataDir} && mkdir -p ${dataDir}`,
      "pnpm exec vite build --logLevel warn",
      "pnpm --dir ../.. --filter '@deskhand/manager...' --silent build",
      "exec node ../manager/dist/main.js",
    ].join(" && "),
    env: managerEnv,
    url: `http://127.0.0.1:${PORT}${BASE}/healthz`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
