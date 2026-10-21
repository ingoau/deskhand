/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Modes
 *  - `vite` (dev): mock API on by default. `MOCK=0 DESKHAND_URL=http://127.0.0.1:7480 vite` proxies a real manager.
 *  - `vite build`: static files in dist/, no mock code (the mock lives in ./mock and is only loaded here, server-side).
 *  - `MOCK=1 vite preview`: serves dist/ like the manager would, under MOCK_BASE (default /deskhand/), with the mock API.
 */
export default defineConfig(async ({ command, isPreview }) => {
  const mockOn = command === "serve" && !isPreview && !process.env.VITEST && process.env.MOCK !== "0";
  const previewMock = !!isPreview && process.env.MOCK === "1";
  const plugins: PluginOption[] = [react(), tailwindcss()];
  if (mockOn || previewMock) {
    const { mockApi } = await import("./mock/plugin.ts");
    plugins.push(mockApi({ base: process.env.MOCK_BASE ?? "/deskhand/" }));
  }
  const target = process.env.DESKHAND_URL ?? "http://127.0.0.1:7480";
  return {
    // Relative asset URLs + <base href> injected by the manager = works under any DESKHAND_BASE_PATH.
    base: "./",
    plugins,
    resolve: {
      alias: { "@deskhand/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)) },
    },
    // noVNC uses top-level await.
    build: { target: "es2022", outDir: "dist", emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 700 },
    esbuild: { target: "es2022" },
    optimizeDeps: { esbuildOptions: { target: "es2022" } },
    server: {
      host: "127.0.0.1",
      proxy: mockOn
        ? undefined
        : {
            "/api": { target, ws: true, changeOrigin: false },
            "/auth": { target, changeOrigin: false },
          },
    },
    preview: { host: "127.0.0.1" },
    test: {
      include: ["src/**/*.test.ts", "mock/**/*.test.ts"],
      environment: "node",
    },
  };
});
