// Bundles the daemon into one ESM file for the desktop image. sharp is native and is
// installed next to the bundle in the image (see images/desktop/Dockerfile).
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await build({
  entryPoints: [resolve(root, "src/main.ts")],
  outfile: resolve(root, "dist/bundle/daemon.mjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: "linked",
  external: ["sharp", "bufferutil", "utf-8-validate"],
  // CommonJS deps (x11, ws) call require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
});
