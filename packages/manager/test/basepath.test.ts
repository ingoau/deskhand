import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { injectBase } from "../src/static.js";
import type { FakeRuntime } from "../src/runtime/fake.js";
import { connectMcp, startManager, textOf, tmpDir, type TestManager } from "./helpers.js";

describe("injectBase", () => {
  it("rewrites the base href and sets window.__DESKHAND_BASE__", () => {
    const html = `<!doctype html><html><head><meta charset="utf-8" /><base href="/" /><title>x</title></head><body></body></html>`;
    const out = injectBase(html, "/deskhand");
    expect(out).toContain(`<base href="/deskhand/">`);
    expect(out).toContain(`window.__DESKHAND_BASE__ = "/deskhand/"`);
    expect(out.match(/<base /g)).toHaveLength(1);
    expect(injectBase(html, "")).toContain(`<base href="/">`);
  });
});

describe("base path routing and dashboard serving", () => {
  let t: TestManager;
  const dash = tmpDir("deskhand-dash-");
  beforeAll(async () => {
    fs.mkdirSync(path.join(dash, "assets"));
    fs.writeFileSync(path.join(dash, "index.html"), `<!doctype html><html><head><base href="/" /></head><body><div id="root"></div></body></html>`);
    fs.writeFileSync(path.join(dash, "assets", "app-abc123.js"), "console.log(1)");
    t = await startManager({ env: { DESKHAND_BASE_PATH: "/deskhand", DESKHAND_DASHBOARD_DIR: dash } });
  });
  afterAll(async () => {
    await t.close();
    await (t.runtime as FakeRuntime).destroy();
    fs.rmSync(dash, { recursive: true, force: true });
  });
  const root = () => new URL(t.url).origin;

  it("serves everything under the base path only", async () => {
    expect((await fetch(`${root()}/deskhand/healthz`)).status).toBe(200);
    expect((await fetch(`${root()}/healthz`)).status).toBe(404);
    expect((await fetch(`${root()}/api/desktops`, { headers: { authorization: `Bearer ${t.token}` } })).status).toBe(404);
    const redirect = await fetch(`${root()}/deskhand`, { redirect: "manual" });
    expect(redirect.status).toBeGreaterThanOrEqual(301);
    expect(redirect.headers.get("location")).toBe("/deskhand/");
  });

  it("serves index.html with the base injected, assets, and the SPA fallback", async () => {
    const index = await fetch(`${root()}/deskhand/`);
    expect(index.headers.get("cache-control")).toBe("no-cache");
    const html = await index.text();
    expect(html).toContain(`<base href="/deskhand/">`);
    expect(html).toContain(`window.__DESKHAND_BASE__ = "/deskhand/"`);
    const spa = await fetch(`${root()}/deskhand/desktops/abc/log`);
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain("__DESKHAND_BASE__");
    const asset = await fetch(`${root()}/deskhand/assets/app-abc123.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect((await fetch(`${root()}/deskhand/assets/missing.js`)).status).toBe(404);
    expect((await fetch(`${root()}/deskhand/api/nope`, { headers: { authorization: `Bearer ${t.token}` } })).status).toBe(404);
    expect((await fetch(`${root()}/deskhand/../../etc/passwd`)).status).not.toBe(500);
  });

  it("serves MCP under the base path", async () => {
    const { client } = await connectMcp(t.url, t.token);
    const r = await client.callTool({ name: "desktop_list", arguments: {} });
    expect(textOf(r)).toContain("no desktops");
    await client.close();
  });
});
