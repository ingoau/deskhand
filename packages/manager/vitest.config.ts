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
    // Files run one at a time: they share the 17200-17299 port range and (for test:docker) one engine.
    fileParallelism: false,
  },
});
