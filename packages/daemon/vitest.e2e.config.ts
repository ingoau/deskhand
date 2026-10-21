import { defineConfig } from "vitest/config";

// Desktop end-to-end tests: start a deskhand-desktop:dev container and check effects inside it.
// Run with: DEV_DOCKER=1 scripts/dev pnpm --filter @deskhand/daemon test:e2e
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.test.ts"],
    environment: "node",
    testTimeout: 90_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    sequence: { concurrent: false },
    globalSetup: ["test/e2e/global-setup.ts"],
  },
});
