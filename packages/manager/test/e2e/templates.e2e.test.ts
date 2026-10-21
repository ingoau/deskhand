/**
 * Phase 4 "done when", scripted (no LLM), against the real desktop image:
 *  - a login saved in a template is already active in a newly started desktop, and the manifest lists the site
 *  - cookies survive quiesce + commit; bind mounts never end up in the image
 *  - a change in one desktop does not appear in another started from the same template
 *  - desktop_start's description lists the template and a connected client gets tools/list_changed
 *  - a base-image update rebuilds recipe-backed templates (recipe replayed, logins carried) and flags
 *    snapshot-only ones as outdated
 *
 * Run: DEV_DOCKER=1 scripts/dev env DESKHAND_E2E_IMAGE=deskhand-desktop:dev pnpm --filter @deskhand/manager test:e2e
 * Resources are labelled owner=deskhand-dev + a per-run deskhand.instance and removed afterwards. The test
 * site (suite/fixtures/login-site) runs in a container of the desktop image on the run's desktop network.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Docker from "dockerode";
import tar from "tar-stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { LABELS } from "@deskhand/shared";
import { api, connectMcp, startManager, textOf, waitFor, type TestManager } from "../helpers.js";

const docker = new Docker();
const IMAGE = process.env.DESKHAND_E2E_IMAGE ?? "deskhand-desktop:dev";
const run = `e${Math.random().toString(36).slice(2, 7)}`;
const instance = `p4e2e-${run}`;
const network = `deskhand-e2e-${run}`;
const repo = `deskhand-template-e2e-${run}`;
const IMAGE_B = `deskhand-desktop:e2e-${run}-b`;
const SITE = "http://shop.deskhand.test";
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const fixtures = path.join(repoRoot, "suite", "fixtures", "login-site");
const hostDir = path.join(repoRoot, "tmp", `e2e-templates-${run}`);
const dataDir = path.join(hostDir, "data");
const BROWSER = fs.readFileSync(path.join(fixtures, "browser.mjs"), "utf8");
let siteId = "";
let t: TestManager | undefined;

const ENV = (image: string): Record<string, string> => ({
  DESKHAND_RUNTIME: "docker",
  DESKHAND_OWNER_LABEL: "deskhand-dev",
  DESKHAND_INSTANCE: instance,
  DESKHAND_NETWORK: network,
  DESKHAND_DESKTOP_IMAGE: image,
  DESKHAND_CONTAINER_PREFIX: `dh${run}-`,
  DESKHAND_TEMPLATE_REPO: repo,
  DESKHAND_MAX_DESKTOPS: "3",
  DESKHAND_HEALTH_INTERVAL: "1s",
  DESKHAND_SWEEP_INTERVAL: "1s",
  DESKHAND_START_TIMEOUT: "90s",
});

/** desktop_exec of the CDP driver; returns its output. */
function browser(args: string): string {
  return `cat > /tmp/browser.mjs <<'DESKHAND_EOF'\n${BROWSER}\nDESKHAND_EOF\nnode /tmp/browser.mjs ${args}`;
}

function idOf(r: unknown): string {
  const m = /Desktop (\w+) is ready/.exec(textOf(r as { content?: unknown }));
  if (!m) throw new Error(`desktop_start failed: ${textOf(r as { content?: unknown })}`);
  return m[1]!;
}

async function exec(client: Awaited<ReturnType<typeof connectMcp>>["client"], command: string, desktop?: string) {
  const r = await client.callTool({ name: "desktop_exec", arguments: { command, timeout: 90, ...(desktop ? { desktop } : {}) } }, undefined, { timeout: 120_000 });
  return textOf(r);
}

async function siteLogins(): Promise<number> {
  const ex = await docker.getContainer(siteId).exec({ Cmd: ["python3", "-c", "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1/sessions').read().decode())"], AttachStdout: true, AttachStderr: true });
  const stream = await ex.start({ hijack: true, stdin: false });
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve) => {
    stream.on("data", (d: Buffer) => chunks.push(d));
    stream.on("end", () => resolve());
  });
  const text = Buffer.concat(chunks).toString("latin1");
  return Number(/"count":\s*(\d+)/.exec(text)?.[1] ?? NaN);
}

async function buildBaseB() {
  const pack = tar.pack();
  pack.entry({ name: "Dockerfile" }, `FROM ${IMAGE}\nRUN echo "base-b ${run}" > /etc/deskhand-base-marker\nLABEL owner=deskhand-dev\n`);
  pack.finalize();
  const stream = await docker.buildImage(pack as unknown as NodeJS.ReadableStream, { t: IMAGE_B, labels: { owner: "deskhand-dev", [LABELS.instance]: instance }, rm: true, forcerm: true });
  await new Promise<void>((resolve, reject) =>
    docker.modem.followProgress(stream, (err: Error | null, out: Array<{ error?: string }>) => {
      const failed = out?.find((o) => o.error);
      if (err || failed) reject(err ?? new Error(failed!.error));
      else resolve();
    }),
  );
}

beforeAll(async () => {
  fs.mkdirSync(path.join(hostDir, "work"), { recursive: true });
  fs.writeFileSync(path.join(hostDir, "work", "workspace-secret.txt"), "must never be in a template");
  await docker.createNetwork({ Name: network, Driver: "bridge", Labels: { owner: "deskhand-dev", [LABELS.instance]: instance } });
  const site = await docker.createContainer({
    name: `dh${run}-shop`,
    Image: IMAGE,
    Entrypoint: ["python3", "/site/server.py", "--port", "80"],
    Labels: { owner: "deskhand-dev", [LABELS.instance]: instance },
    HostConfig: { Binds: [`${fixtures}:/site:ro`], NetworkMode: network },
    NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: ["shop.deskhand.test"] } } },
  });
  siteId = site.id;
  await site.start();
  t = await startManager({ dataDir, env: ENV(IMAGE) });
}, 300_000);

afterAll(async () => {
  await t?.close({ keepData: true }).catch(() => undefined);
  const cs = await docker.listContainers({ all: true, filters: { label: [`owner=deskhand-dev`, `${LABELS.instance}=${instance}`] } });
  for (const c of cs) await docker.getContainer(c.Id).remove({ force: true }).catch(() => undefined);
  const imgs = await docker.listImages({ filters: { reference: [`${repo}`] } });
  for (const i of imgs) await docker.getImage(i.Id).remove({ force: true }).catch(() => undefined);
  await docker.getImage(IMAGE_B).remove({ force: true }).catch(() => undefined);
  await docker.getNetwork(network).remove().catch(() => undefined);
  fs.rmSync(hostDir, { recursive: true, force: true });
}, 180_000);

describe("templates on the real desktop image", () => {
  it("saves a login into a template; a new desktop from it is already logged in; mounts stay out", { timeout: 600_000 }, async () => {
    const { client, transport } = await connectMcp(t!.url, t!.token);
    let changed = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => void changed++);
    const a = idOf(await client.callTool({ name: "desktop_start", arguments: { mounts: [{ path: path.join(hostDir, "work"), write: true }] } }, undefined, { timeout: 120_000 }));
    expect(await exec(client, `cat ${path.join(hostDir, "work", "workspace-secret.txt")}`)).toContain("must never be in a template");
    expect(await exec(client, browser(`status ${SITE}`))).toContain("Not signed in");
    expect(await exec(client, browser(`login ${SITE} alice correct-horse`))).toContain("Signed in as alice");
    expect(await siteLogins()).toBe(1);

    const save = await client.callTool(
      {
        name: "template_save",
        arguments: {
          name: "shop",
          description: { summary: "Chromium signed into the Test Shop as alice", use_when: "Tasks in the Test Shop (http://shop.deskhand.test)", tags: ["shop"] },
        },
      },
      undefined,
      { timeout: 300_000 },
    );
    expect(save.isError, textOf(save)).toBeFalsy();
    expect(textOf(save)).toContain("Saved template shop v1");
    expect(textOf(save)).toContain("Logged-in sites recorded: deskhand.test");
    await waitFor(() => changed > 0, { what: "tools/list_changed after template_save" });
    const { tools } = await client.listTools();
    expect(tools.find((x) => x.name === "desktop_start")!.description).toContain("shop: Chromium signed into the Test Shop as alice. Use when: Tasks in the Test Shop");

    const info = (await api(t!, "GET", "/api/templates/shop")).data;
    expect(info.loggedInSites).toEqual(["deskhand.test"]);
    expect(info.versions[0].packages).toEqual([]);
    expect(info.versions[0].manifestNotes).toEqual([]);
    expect(info.baseVersion).toBe(info.currentBaseVersion);
    expect(info.versions[0].savedFrom.desktop).toBe(a);
    await client.callTool({ name: "desktop_stop", arguments: { desktop: a } });

    // New desktop from the template: logged in without logging in again; no workspace files.
    const b = idOf(await client.callTool({ name: "desktop_start", arguments: { template: "shop" } }, undefined, { timeout: 120_000 }));
    expect((await api(t!, "GET", `/api/desktops/${b}`)).data).toMatchObject({ template: "shop", templateVersion: 1 });
    expect(await exec(client, browser(`status ${SITE}`), b)).toContain("Signed in as alice");
    expect(await siteLogins()).toBe(1);
    const ls = await exec(client, `ls -A ${path.join(hostDir, "work")} 2>&1; echo "[end]"`, b);
    expect(ls).not.toContain("workspace-secret.txt");
    await transport.terminateSession();
  });

  it("keeps desktops started from the same template independent", { timeout: 600_000 }, async () => {
    const { client, transport } = await connectMcp(t!.url, t!.token);
    const a = idOf(await client.callTool({ name: "desktop_start", arguments: { template: "shop" } }, undefined, { timeout: 120_000 }));
    const b = idOf(await client.callTool({ name: "desktop_start", arguments: { template: "shop" } }, undefined, { timeout: 120_000 }));
    await exec(client, "echo from-a > ~/Documents/only-in-a.txt", a);
    expect(await exec(client, browser(`logout ${SITE}`), a)).toContain("Not signed in");
    expect(await exec(client, "ls ~/Documents; echo [end]", b)).not.toContain("only-in-a.txt");
    expect(await exec(client, browser(`status ${SITE}`), b)).toContain("Signed in as alice");
    expect(await exec(client, browser(`status ${SITE}`), a)).toContain("Not signed in");
    await client.callTool({ name: "template_feedback", arguments: { result: "ok", note: "still signed in", desktop: b } });
    const s = (await api(t!, "GET", "/api/templates/shop")).data;
    expect(s).toMatchObject({ stale: false, lastFeedback: { kind: "ok", version: 1 } });
    await transport.terminateSession();
  });

  it("rebuilds recipe-backed templates on a new base image and flags snapshot-only ones", { timeout: 900_000 }, async () => {
    const { client, transport } = await connectMcp(t!.url, t!.token);
    // A recipe-backed template: recipe (as root) installs a tiny local .deb and writes config; the snapshot adds the login.
    const recipe = [
      "# deskhand: run-as=root",
      "set -e",
      "d=$(mktemp -d); mkdir -p $d/pkg/DEBIAN $d/pkg/usr/share/deskhand-e2e",
      "printf 'Package: deskhand-e2e-tool\\nVersion: 1.0\\nArchitecture: all\\nMaintainer: e2e <e2e@example.invalid>\\nDescription: e2e test package\\n' > $d/pkg/DEBIAN/control",
      "echo tool > $d/pkg/usr/share/deskhand-e2e/tool.txt",
      "dpkg-deb --build $d/pkg $d/tool.deb >/dev/null && dpkg -i $d/tool.deb >/dev/null && rm -rf $d",
      "runuser -u agent -- sh -c 'mkdir -p ~/.config && echo recipe-ran > ~/.config/shop-recipe-marker'",
    ].join("\n");
    const d = idOf(await client.callTool({ name: "desktop_start", arguments: {} }, undefined, { timeout: 120_000 }));
    // What the recipe automates, done by hand here (the agent has no root, so the package comes from the recipe on rebuild).
    await exec(client, "mkdir -p ~/.config && echo recipe-ran > ~/.config/shop-recipe-marker", d);
    expect(await exec(client, browser(`login ${SITE} alice correct-horse`), d)).toContain("Signed in as alice");
    const save = await client.callTool(
      { name: "template_save", arguments: { name: "shop-recipe", description: { summary: "Test Shop login plus the e2e tool", use_when: "Rebuild tests" }, recipe } },
      undefined,
      { timeout: 300_000 },
    );
    expect(textOf(save)).toContain("Saved template shop-recipe v1");
    await transport.terminateSession();
    const before = (await api(t!, "GET", "/api/templates/shop-recipe")).data;
    const loginsBefore = await siteLogins();

    // Simulate a base-image update: a trivially changed image, manager restarted with it.
    await buildBaseB();
    await t!.close({ keepData: true });
    t = await startManager({ dataDir, env: ENV(IMAGE_B) });
    await waitFor(async () => ["ok", "failed"].includes((await api(t!, "GET", "/api/templates/shop-recipe")).data.rebuild?.status), {
      timeout: 600_000,
      interval: 2000,
      what: "shop-recipe rebuilt",
    });
    const after = (await api(t!, "GET", "/api/templates/shop-recipe")).data;
    expect(after.rebuild, JSON.stringify(after.rebuild)).toMatchObject({ status: "ok", version: 2 });
    expect(after.currentVersion).toBe(2);
    expect(after.baseVersion).not.toBe(before.baseVersion);
    expect(after.baseVersion).toBe(after.currentBaseVersion);
    expect(after.outdatedBase).toBe(false);
    expect(after.versions[0]).toMatchObject({ version: 2, rebuiltFrom: 1, hasRecipe: true, loggedInSites: ["deskhand.test"] });
    expect(after.versions[0].packages).toEqual(["deskhand-e2e-tool 1.0"]);
    expect(after.versions[0].manifestNotes.join(" ")).toContain("carried from the snapshot: ~/.config/chromium");
    // Snapshot-only template: flagged, not rebuilt.
    const shop = (await api(t!, "GET", "/api/templates/shop")).data;
    expect(shop).toMatchObject({ currentVersion: 1, outdatedBase: true, hasRecipe: false });

    // A desktop from the rebuilt version has the new base, the recipe's results and the carried login.
    const c2 = await connectMcp(t!.url, t!.token);
    const n = idOf(await c2.client.callTool({ name: "desktop_start", arguments: { template: "shop-recipe" } }, undefined, { timeout: 120_000 }));
    expect(await exec(c2.client, "cat /etc/deskhand-base-marker", n)).toContain(`base-b ${run}`);
    expect(await exec(c2.client, "cat ~/.config/shop-recipe-marker /usr/share/deskhand-e2e/tool.txt", n)).toMatch(/recipe-ran[\s\S]*tool/);
    expect(await exec(c2.client, browser(`status ${SITE}`), n)).toContain("Signed in as alice");
    expect(await siteLogins()).toBe(loginsBefore);
    await c2.transport.terminateSession();
    // No build desktop is left behind.
    expect((await api(t!, "GET", "/api/desktops")).data.desktops.filter((x: { title: string | null }) => x.title?.startsWith("rebuild template"))).toEqual([]);
  });
});
