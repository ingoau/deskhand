import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clearDir, coreDumps, touchesMount } from "../../src/quiesce.js";
import { checkAuth } from "../../src/server.js";
import { rewriteCdpBody } from "../../src/cdp.js";

describe("touchesMount", () => {
  it("detects mount points at or below a path", () => {
    const mounts = ["/", "/proc", "/tmp/work", "/home/agent/Downloads"];
    expect(touchesMount("/tmp/work", mounts)).toBe(true);
    expect(touchesMount("/tmp", mounts)).toBe(true);
    expect(touchesMount("/tmp/other", mounts)).toBe(false);
    expect(touchesMount("/home/agent/Downloads/", mounts)).toBe(true);
    expect(touchesMount("/home/agent/.cache", mounts)).toBe(false);
  });
});

describe("clearDir", () => {
  it("removes contents, keeps listed names and skips mount points", () => {
    const d = mkdtempSync(join(tmpdir(), "deskhand-q-"));
    mkdirSync(join(d, "cache/sub"), { recursive: true });
    writeFileSync(join(d, "cache/sub/f"), "x");
    writeFileSync(join(d, "file"), "x");
    mkdirSync(join(d, ".X11-unix"));
    mkdirSync(join(d, "mounted"));
    writeFileSync(join(d, "mounted/keep"), "x");
    const r = clearDir(d, [join(d, "mounted")], new Set([".X11-unix"]));
    expect(readdirSync(d).sort()).toEqual([".X11-unix", "mounted"]);
    expect(readdirSync(join(d, "mounted"))).toEqual(["keep"]);
    expect(r.removed).toBe(2);
    expect(r.skipped).toEqual([join(d, "mounted")]);
  });
});

describe("coreDumps", () => {
  it("finds core files of crashed apps but not similarly named dirs, other files or mounts", () => {
    const d = mkdtempSync(join(tmpdir(), "deskhand-core-"));
    for (const f of ["core", "core.274", "core.txt", "score.1"]) writeFileSync(join(d, f), "x");
    mkdirSync(join(d, "core.9"));
    writeFileSync(join(d, "core.55"), "x");
    expect(coreDumps(d, [join(d, "core.55")]).sort()).toEqual([join(d, "core"), join(d, "core.274")]);
  });
});

describe("checkAuth", () => {
  it("accepts only the exact bearer key", () => {
    expect(checkAuth("Bearer abc123", "abc123")).toBe(true);
    expect(checkAuth("bearer abc123", "abc123")).toBe(true);
    expect(checkAuth("Bearer abc124", "abc123")).toBe(false);
    expect(checkAuth("Bearer abc", "abc123")).toBe(false);
    expect(checkAuth(undefined, "abc123")).toBe(false);
    expect(checkAuth("Bearer abc123", null)).toBe(false);
  });
});

describe("rewriteCdpBody", () => {
  it("points websocket URLs back through the daemon", () => {
    const body = JSON.stringify({
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/abc",
      devtoolsFrontendUrl: "/devtools/inspector.html?ws=127.0.0.1:9222/devtools/page/X",
    });
    const out = JSON.parse(rewriteCdpBody(body, { ws: "ws://10.0.0.5:7000/cdp", hostPath: "10.0.0.5:7000/cdp" }));
    expect(out.webSocketDebuggerUrl).toBe("ws://10.0.0.5:7000/cdp/devtools/browser/abc");
    expect(out.devtoolsFrontendUrl).toBe("/devtools/inspector.html?ws=10.0.0.5:7000/cdp/devtools/page/X");
  });
});
