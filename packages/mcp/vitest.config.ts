import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@deskhand/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)) },
  },
});
