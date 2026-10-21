import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@deskhand/shared": src("../shared/src/index.ts"),
      "@deskhand/mcp": src("../mcp/src/index.ts"),
    },
  },
  test: {
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // Docker tests share one engine; run their files one at a time.
    fileParallelism: !process.argv.some((a) => a.includes("test/docker")),
  },
});
