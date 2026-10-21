/**
 * Phase 4 template logic on the fake runtime: description rules, manifests, feedback/stale,
 * agent-change marker, rollback, pruning, recipe edits, diffs, list_changed and base-update rebuilds.
 * The real-image end-to-end version is test/e2e/templates.e2e.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { templateLines } from "@deskhand/mcp";
import type { FakeRuntime } from "../src/runtime/fake.js";
import { extensionLabels, loggedInSites, parseProbe, registrableDomain, type CookieMeta } from "../src/manifest.js";
import { baseVersionString } from "../src/templates.js";
import { recipeRunsAsRoot } from "../src/template-ops.js";
import { api, connectMcp, startManager, textOf, tmpDir, waitFor, type TestManager } from "./helpers.js";

const NOW = 1_800_000_000;
const ck = (host: string, name: string, o: Partial<CookieMeta> = {}): CookieMeta => ({
  browser: "chromium",
  host,
  name,
  persistent: true,
  expires: NOW + 86_400 * 30,
  httpOnly: false,
  ...o,
});

describe("manifest classification", () => {
  it("finds sites with persistent login-like cookies and ignores trackers, prefs and expired ones", () => {
    const sites = loggedInSites(
      [
        ck(".github.com", "user_session", { httpOnly: true }),
        ck("github.com", "_octo"),
        ck(".google.com", "NID", { httpOnly: true }),
        ck(".google.com", "_ga"),
        ck("accounts.example.co.uk", "remember_me"),
        ck("app.linear.app", "lnr_opaque", { httpOnly: true }),
        ck("news.site", "theme"),
        ck("old.site", "session", { expires: NOW - 10 }),
        ck("tmp.site", "session", { persistent: false, expires: null }),
        ck("shop.deskhand.test", "session", { httpOnly: true }),
        ck("localhost", "sid"),
      ],
      NOW,
    );
    expect(sites).toEqual(["deskhand.test", "example.co.uk", "github.com", "linear.app", "localhost"]);
  });

  it("normalises hosts to registrable domains", () => {
    expect(registrableDomain(".accounts.google.com")).toBe("google.com");
    expect(registrableDomain("www.bbc.co.uk")).toBe("bbc.co.uk");
    expect(registrableDomain("10.0.0.5")).toBe("10.0.0.5");
    expect(registrableDomain("intranet")).toBe("intranet");
  });

  it("labels extensions and parses probe output defensively", () => {
    expect(
      extensionLabels([
        { browser: "chromium", id: "a", name: "Refined GitHub", version: "24.10.1" },
        { browser: "firefox", id: "b", name: "uBlock Origin", version: "1.60" },
      ]),
    ).toEqual(["Firefox: uBlock Origin 1.60", "Refined GitHub 24.10.1"]);
    const p = parseProbe('noise\n{"cookies":[],"packages":["jq 1.7"],"baseList":true}');
    expect(p).toMatchObject({ cookies: [], extensions: [], packages: ["jq 1.7"], baseList: true, notes: [] });
  });

  it("formats base versions and recipe run-as markers", () => {
    expect(baseVersionString("0.1.0", "2026-10-22T10:11:12.000Z")).toBe("0.1.0+20261022.101112");
    expect(recipeRunsAsRoot("#!/bin/bash\n# deskhand: run-as=root\napt-get install -y jq")).toBe(true);
    expect(recipeRunsAsRoot("echo hi\n# deskhand: run-as=root")).toBe(true);
    expect(recipeRunsAsRoot("echo '# deskhand: run-as=root'")).toBe(false);
  });
});

describe("templates (fake runtime)", () => {
  let t: TestManager;
  const fake = () => t.runtime as FakeRuntime;
  const dataDir = tmpDir();

  beforeAll(async () => {
    t = await startManager({ dataDir, env: { DESKHAND_TEMPLATE_VERSIONS: "2", DESKHAND_TEMPLATE_REPO: "deskhand-template-unit" } });
  });
  afterAll(async () => {
    await t?.close();
    await fake()?.destroy();
  });

  it("requires a description for a new template and a restated or confirmed one for each new version", async () => {
    const { client, transport } = await connectMcp(t.url, t.token);
    const start = await client.callTool({ name: "desktop_start", arguments: {} });
    const id = /Desktop (\w+) is ready/.exec(textOf(start))![1]!;
    fake().daemonFor(id)!.behavior.manifest = {
      cookies: [ck("shop.deskhand.test", "session", { httpOnly: true, expires: Date.now() / 1000 + 3600 }), ck(".deskhand.test", "_ga")],
      extensions: [{ browser: "chromium", id: "x", name: "Refined GitHub", version: "1.0" }],
      packages: ["jq 1.7.1"],
      baseList: true,
      notes: [],
    };

    const noDesc = await client.callTool({ name: "template_save", arguments: { name: "shop" } });
    expect(noDesc.isError).toBe(true);
    expect(textOf(noDesc)).toContain("new template");

    const v1 = await client.callTool({
      name: "template_save",
      arguments: { name: "shop", description: { summary: "Chromium logged into the test shop", use_when: "Buying things in the test shop" }, recipe: "echo setup > ~/.shoprc" },
    });
    expect(v1.isError, textOf(v1)).toBeFalsy();
    expect(textOf(v1)).toContain("Saved template shop v1");
    expect(textOf(v1)).toContain("Logged-in sites recorded: deskhand.test");
    expect(fake().daemonFor(id)!.behavior.quiesced).toBe(1);
    expect(fake().images.has("deskhand-template-unit:shop-v1")).toBe(true);

    const again = await client.callTool({ name: "template_save", arguments: { name: "shop" } });
    expect(again.isError).toBe(true);
    expect(textOf(again)).toContain("confirm_description");
    expect(textOf(again)).toContain("Chromium logged into the test shop");

    const v2 = await client.callTool({ name: "template_save", arguments: { name: "shop", confirm_description: true } });
    expect(textOf(v2)).toContain("Saved template shop v2");

    const info = (await api(t, "GET", "/api/templates/shop")).data;
    expect(info).toMatchObject({
      name: "shop",
      currentVersion: 2,
      loggedInSites: ["deskhand.test"],
      extensions: ["Refined GitHub 1.0"],
      hasRecipe: true, // an omitted recipe keeps the previous one
      recentlyChangedByAgent: true,
      stale: false,
      outdatedBase: false,
    });
    expect(info.recipe).toBe("echo setup > ~/.shoprc");
    const [latest, first] = info.versions;
    expect(latest).toMatchObject({ version: 2, byAgent: true, description: { summary: "Chromium logged into the test shop" }, packages: ["jq 1.7.1"] });
    expect(latest.savedFrom).toMatchObject({ desktop: id });
    expect(latest.savedFrom.session).toMatch(/^test-/);
    expect(first.changes).toMatchObject({ from: null, loggedInSites: { added: ["deskhand.test"], removed: [] } });
    await transport.terminateSession();
  });

  it("records feedback with version and session; a problem marks the template stale until a new version", async () => {
    const { client, transport } = await connectMcp(t.url, t.token);
    let changed = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => void changed++);
    const started = textOf(await client.callTool({ name: "desktop_start", arguments: { template: "shop" } }));
    expect(started).toContain("template shop v2");
    expect(started).toContain("Template shop is already signed in to: deskhand.test");
    expect(started).toContain("template_feedback");
    await client.callTool({ name: "template_feedback", arguments: { result: "ok", note: "logged in fine" } });
    let s = (await api(t, "GET", "/api/templates/shop")).data;
    expect(s.lastConfirmedAt).toBeTruthy();
    expect(s.stale).toBe(false);
    expect(s.lastFeedback).toMatchObject({ kind: "ok", version: 2, note: "logged in fine" });
    expect(s.lastFeedback.session).toMatch(/^test-/);
    await client.callTool({ name: "template_feedback", arguments: { result: "problem", note: "shop login expired" } });
    s = (await api(t, "GET", "/api/templates/shop")).data;
    expect(s).toMatchObject({ stale: true, staleReason: "problem reported: shop login expired" });
    await waitFor(() => changed >= 2, { what: "list_changed after feedback" });
    const { tools } = await client.listTools();
    const desc = tools.find((x) => x.name === "desktop_start")!.description!;
    expect(desc).toContain("shop: Chromium logged into the test shop. Use when: Buying things in the test shop [logged in: deskhand.test; stale: problem reported: shop login expired]");
    expect(desc).toContain("reuse a template that fits");
    const list = JSON.parse(textOf(await client.callTool({ name: "template_list", arguments: {} })));
    expect(list.find((x: { name: string }) => x.name === "shop")).toMatchObject({ logged_in_sites: ["deskhand.test"], stale: "problem reported: shop login expired" });
    await transport.terminateSession();
  });

  it("keeps the last N versions plus any in use, rolls back, and prunes once the desktop is gone", async () => {
    const { client, transport } = await connectMcp(t.url, t.token);
    // A desktop on v2 keeps v2 alive through later saves.
    const onV2 = await client.callTool({ name: "desktop_start", arguments: { template: "shop" } });
    const v2desk = /Desktop (\w+) is ready/.exec(textOf(onV2))![1]!;
    const other = await client.callTool({ name: "desktop_start", arguments: {} });
    const otherId = /Desktop (\w+) is ready/.exec(textOf(other))![1]!;
    for (const n of [3, 4, 5]) {
      const r = await client.callTool({ name: "template_save", arguments: { name: "shop", confirm_description: true, desktop: otherId } });
      expect(textOf(r)).toContain(`shop v${n}`);
    }
    let info = (await api(t, "GET", "/api/templates/shop")).data;
    expect(info.versions.map((v: { version: number }) => v.version)).toEqual([5, 4, 2]);
    expect(fake().images.has("deskhand-template-unit:shop-v1")).toBe(false);
    expect(fake().images.has("deskhand-template-unit:shop-v3")).toBe(false);
    expect(info.versions.find((v: { version: number }) => v.version === 2).inUse).toBe(1);

    // Rollback without a version goes to the previous kept one.
    expect((await api(t, "POST", "/api/templates/shop/rollback", {})).data.currentVersion).toBe(4);
    expect((await api(t, "POST", "/api/templates/shop/rollback", { version: 5 })).data.currentVersion).toBe(5);

    await client.callTool({ name: "desktop_stop", arguments: { desktop: v2desk } });
    await waitFor(async () => !fake().images.has("deskhand-template-unit:shop-v2"), { what: "v2 pruned after its desktop was removed" });
    info = (await api(t, "GET", "/api/templates/shop")).data;
    expect(info.versions.map((v: { version: number }) => v.version)).toEqual([5, 4]);

    const diff = (await api(t, "GET", "/api/templates/shop/diff?from=4&to=5")).data;
    expect(diff).toMatchObject({ from: 4, description: [], recipeChanged: false });
    await transport.terminateSession();
  });

  it("edits the recipe and refuses rebuilds of snapshot-only templates", async () => {
    const r = await api(t, "PUT", "/api/templates/shop/recipe", { recipe: "# deskhand: run-as=root\napt-get install -y jq" });
    expect(r.status).toBe(200);
    expect(r.data.recipe).toContain("apt-get install -y jq");
    const { client, transport } = await connectMcp(t.url, t.token);
    await client.callTool({ name: "desktop_start", arguments: {} });
    await client.callTool({ name: "template_save", arguments: { name: "notes", description: { summary: "Mousepad notes", use_when: "Taking notes" }, recipe: "" } });
    const reb = await api(t, "POST", "/api/templates/notes/rebuild");
    expect(reb.status).toBe(400);
    expect(reb.data.error.message).toContain("no recipe");
    await transport.terminateSession();
  });

  it("rebuilds recipe-backed templates when the base image changes and flags snapshot-only ones", async () => {
    const runtime = fake();
    await t.close({ keepData: true });
    runtime.imageIds.set(t.m.cfg.desktopImage, "sha256:new-base");
    runtime.execCalls.length = 0;
    t = await startManager({ dataDir, runtime, env: { DESKHAND_TEMPLATE_VERSIONS: "2", DESKHAND_TEMPLATE_REPO: "deskhand-template-unit" } });
    await waitFor(async () => (await api(t, "GET", "/api/templates/shop")).data.rebuild?.status === "ok", { timeout: 15_000, what: "shop rebuilt" });
    const shop = (await api(t, "GET", "/api/templates/shop")).data;
    expect(shop.currentVersion).toBe(6);
    expect(shop.outdatedBase).toBe(false);
    expect(shop.versions[0]).toMatchObject({ version: 6, rebuiltFrom: 5, byAgent: false, savedBy: "deskhand (base update)", hasRecipe: true });
    expect(shop.versions[0].baseVersion).toBe(shop.currentBaseVersion);
    // The recipe ran as root (marker), then the snapshot's login state was carried over from v5.
    const recipeRun = runtime.execCalls.find((c) => c.cmd.join(" ").includes("deskhand-recipe.sh"));
    expect(recipeRun?.user).toBe("root");
    const copy = runtime.copies.find((c) => c.image === "deskhand-template-unit:shop-v5");
    expect(copy?.paths).toEqual(["/home/agent/.config/chromium", "/home/agent/.mozilla", "/home/agent/.config/mozilla", "/home/agent/.local/share/keyrings", "/home/agent/.pki"]);
    // The build desktop is gone.
    expect((await api(t, "GET", "/api/desktops")).data.desktops.filter((d: { title: string }) => d.title?.startsWith("rebuild template"))).toEqual([]);
    const notes = (await api(t, "GET", "/api/templates/notes")).data;
    expect(notes).toMatchObject({ outdatedBase: true, hasRecipe: false });
    expect(templateLines([notes])).toContain("outdated base image");
  });
});
