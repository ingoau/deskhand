#!/usr/bin/env node
// Prints the license texts of a workspace package's production dependency tree (dependencies and installed
// optionalDependencies, recursively, workspace packages skipped). Used by the image builds for code that ships
// bundled (the desktop daemon's esbuild bundle, the dashboard's Vite build), where node_modules and with them
// each package's LICENSE file are not part of the image.
//   node scripts/third-party-licenses.mjs packages/daemon > THIRD-PARTY-LICENSES.txt
import fs from "node:fs";
import path from "node:path";

const root = fs.realpathSync(path.resolve(process.argv[2] ?? "."));
const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$|^licen[cs]e[-.]/i;

/** Node's lookup from a package's real directory (works with pnpm's symlinked layout). */
function findDep(fromDir, name) {
  let d = fromDir;
  for (;;) {
    const cand = path.basename(d) === "node_modules" ? path.join(d, name) : path.join(d, "node_modules", name);
    if (fs.existsSync(path.join(cand, "package.json"))) return fs.realpathSync(cand);
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

const seen = new Map();
function walk(dir, isRoot) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const deps = { ...(pkg.optionalDependencies ?? {}), ...(pkg.dependencies ?? {}) };
  for (const [name, spec] of Object.entries(deps)) {
    const depDir = findDep(dir, name);
    if (!depDir) {
      if (!(name in (pkg.optionalDependencies ?? {}))) process.stderr.write(`warning: ${name} (needed by ${pkg.name}) not found\n`);
      continue;
    }
    const isWorkspace = String(spec).startsWith("workspace:");
    if (!isWorkspace) {
      const dp = JSON.parse(fs.readFileSync(path.join(depDir, "package.json"), "utf8"));
      const key = `${dp.name}@${dp.version}`;
      if (seen.has(key)) continue;
      seen.set(key, { dir: depDir, pkg: dp });
    } else if (seen.has(depDir)) {
      continue;
    } else {
      seen.set(depDir, null);
    }
    walk(depDir, false);
  }
  return isRoot;
}
walk(root, true);

const out = [`Third-party software bundled into ${path.basename(root)} (generated at build time).`, ""];
for (const [key, v] of [...seen.entries()].filter(([, v]) => v).sort(([a], [b]) => a.localeCompare(b))) {
  const lic = typeof v.pkg.license === "string" ? v.pkg.license : (v.pkg.license?.type ?? JSON.stringify(v.pkg.licenses ?? "UNKNOWN"));
  out.push("=".repeat(78), `${key}  —  ${lic}`, v.pkg.homepage || (typeof v.pkg.repository === "string" ? v.pkg.repository : v.pkg.repository?.url) || "", "");
  const files = fs.readdirSync(v.dir).filter((f) => LICENSE_FILE.test(f)).sort();
  if (files.length === 0) {
    // e.g. sharp's prebuilt libvips: the README carries the licensing details of the bundled libraries.
    out.push(`(no license file in the package; its package.json says: ${lic}. Full GPL/LGPL texts: /usr/share/common-licenses/)`, "");
    const readme = fs.readdirSync(v.dir).find((f) => /^readme(\.md)?$/i.test(f));
    if (readme) out.push(fs.readFileSync(path.join(v.dir, readme), "utf8").trimEnd(), "");
  }
  for (const f of files) out.push(fs.readFileSync(path.join(v.dir, f), "utf8").trimEnd(), "");
}
process.stdout.write(out.join("\n") + "\n");
