/**
 * Integration tests against a real Docker engine, using the stand-in desktop image (fake daemon).
 * Run: DEV_DOCKER=1 scripts/dev pnpm --filter @deskhand/manager test:docker
 * Everything created is labelled owner=deskhand-dev plus a per-run deskhand.instance and removed afterwards.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LABELS } from "@deskhand/shared";
import { api, connectMcp, imagesOf, startManager, textOf, waitFor, type TestManager } from "../helpers.js";
import { buildStandin, imageExists, STANDIN_IMAGE } from "./standin.js";

const docker = new Docker();
const instance = `t${Math.random().toString(36).slice(2, 8)}`;
const network = `deskhand-test-${instance}`;
const HELPER = "busybox:1.37";
// Host paths must exist on the Docker host: use a directory inside the repo (mounted at the same path in scripts/dev).
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const hostDir = path.join(repoRoot, "tmp", `docker-test-${instance}`);
const pulled: string[] = [];
let helperPresent = true;
const managers: TestManager[] = [];

const ENV = {
  DESKHAND_RUNTIME: "docker",
  DESKHAND_OWNER_LABEL: "deskhand-dev",
  DESKHAND_INSTANCE: instance,
  DESKHAND_NETWORK: network,
  DESKHAND_DESKTOP_IMAGE: STANDIN_IMAGE,
  DESKHAND_CONTAINER_PREFIX: `dhtest-${instance}-`,
  DESKHAND_HELPER_IMAGE: HELPER,
  DESKHAND_DESKTOP_MEMORY: "256m",
  DESKHAND_DESKTOP_CPUS: "0.5",
  DESKHAND_MAX_DESKTOPS: "3",
  DESKHAND_HEALTH_INTERVAL: "500ms",
  DESKHAND_SWEEP_INTERVAL: "500ms",
};

let n = 0;
/** Each manager gets its own instance label (two live managers must never share one), unless `inst` is given. */
async function start(extra: Record<string, string> = {}, inst = `${instance}-${++n}`) {
  const t = await startManager({ env: { ...ENV, DESKHAND_INSTANCE: inst, DESKHAND_CONTAINER_PREFIX: `dhtest-${inst}-`, ...extra } });
  managers.push(t);
  return t;
}

/** Every container this run created (any of its instances). */
async function ours() {
  const all = await docker.listContainers({ all: true, filters: { label: ["owner=deskhand-dev", LABELS.instance] } });
  return all.filter((c) => (c.Labels[LABELS.instance] ?? "").startsWith(instance));
}

function idOf(r: unknown): string {
  const m = /Desktop (\w+) is ready/.exec(textOf(r as { content?: unknown }));
  if (!m) throw new Error(`desktop_start failed: ${textOf(r as { content?: unknown })}`);
  return m[1]!;
}

beforeAll(async () => {
  helperPresent = await imageExists(docker, HELPER);
  pulled.push(...(await buildStandin(docker)));
  fs.mkdirSync(path.join(hostDir, "work"), { recursive: true });
  fs.mkdirSync(path.join(hostDir, "secret"), { recursive: true });
  fs.writeFileSync(path.join(hostDir, "work", "in.txt"), "hello from the host");
  fs.symlinkSync(path.join(hostDir, "secret"), path.join(hostDir, "work", "to-secret"));
  fs.symlinkSync("/var/run/docker.sock", path.join(hostDir, "work", "sock"));
}, 300_000);

afterAll(async () => {
  for (const t of managers) await t.close().catch(() => undefined);
  for (const c of await ours()) await docker.getContainer(c.Id).remove({ force: true }).catch(() => undefined);
  await docker.getNetwork(network).remove().catch(() => undefined);
  const imgs = await docker.listImages({ filters: { label: ["owner=deskhand-dev", LABELS.instance] } });
  for (const i of imgs) if ((i.Labels?.[LABELS.instance] ?? "").startsWith(instance)) await docker.getImage(i.Id).remove({ force: true }).catch(() => undefined);
  await docker.getImage(STANDIN_IMAGE).remove({ force: true }).catch(() => undefined);
  for (const p of pulled) await docker.getImage(p).remove().catch(() => undefined);
  if (!helperPresent) await docker.getImage(HELPER).remove().catch(() => undefined);
  fs.rmSync(hostDir, { recursive: true, force: true });
}, 120_000);

describe("Docker lifecycle", () => {
  let t: TestManager;
  let deskId = "";

  it("creates a labelled, capped desktop on its own network with read-only mounts", async () => {
    t = await start();
    const { client } = await connectMcp(t.url, t.token);
    const r = await client.callTool({ name: "desktop_start", arguments: { name: "docker one", mounts: [{ path: path.join(hostDir, "work") }] } });
    expect(r.isError, textOf(r)).toBeFalsy();
    deskId = idOf(r);
    expect(imagesOf(r)).toHaveLength(1);
    const [c] = await ours();
    expect(c).toBeDefined();
    const info = await docker.getContainer(c!.Id).inspect();
    expect(info.Name).toBe(`/dhtest-${instance}-1-${deskId}`);
    expect(info.Config.Labels).toMatchObject({
      owner: "deskhand-dev",
      [LABELS.id]: deskId,
      [LABELS.kind]: "desktop",
      [LABELS.instance]: `${instance}-1`,
      [LABELS.template]: "base",
      [LABELS.title]: "docker one",
      [LABELS.persistent]: "false",
    });
    expect(info.Config.Labels[LABELS.session]).toBeTruthy();
    expect(info.HostConfig.Memory).toBe(256 * 1024 ** 2);
    expect(info.HostConfig.NanoCpus).toBe(0.5e9);
    expect(info.HostConfig.ShmSize).toBe(1024 ** 3);
    expect(info.HostConfig.NetworkMode).toBe(network);
    expect(info.HostConfig.Binds).toEqual([`${path.join(hostDir, "work")}:${path.join(hostDir, "work")}:ro`]);
    const net = await docker.getNetwork(network).inspect();
    expect(net.Labels).toMatchObject({ owner: "deskhand-dev" });

    // The mount is visible at the same path and read-only.
    const cat = await client.callTool({ name: "desktop_exec", arguments: { command: `cat ${path.join(hostDir, "work", "in.txt")}` } });
    expect(textOf(cat)).toContain("hello from the host");
    const touch = await client.callTool({ name: "desktop_exec", arguments: { command: `touch ${path.join(hostDir, "work", "nope")}` } });
    expect(textOf(touch)).toMatch(/Read-only file system|Exit code 1/);
    await client.close();
  });

  it("refuses the Docker socket and denied paths after resolving symlinks with the helper container", async () => {
    const t2 = await start({ DESKHAND_MOUNT_DENY: path.join(hostDir, "secret") });
    const { client } = await connectMcp(t2.url, t2.token);
    for (const p of ["/var/run/docker.sock", path.join(hostDir, "work", "sock"), path.join(hostDir, "work", "to-secret"), "/var/run"]) {
      const r = await client.callTool({ name: "desktop_start", arguments: { mounts: [{ path: p }] } });
      expect(textOf(r), p).toContain("mount_refused");
    }
    expect((await ours()).filter((c) => c.Labels[LABELS.kind] === "helper")).toHaveLength(0);
    await client.close();
  });

  it("copies files between host and desktop with file_put / file_get", async () => {
    const { client, transport } = await connectMcp(t.url, t.token);
    const s = await client.callTool({ name: "desktop_start", arguments: {} });
    const id = idOf(s);
    const put = await client.callTool({ name: "file_put", arguments: { host_path: path.join(hostDir, "work", "in.txt"), desktop_path: "/home/agent/in.txt" } });
    expect(textOf(put)).toContain("Copied 19 bytes");
    const cat = await client.callTool({ name: "desktop_exec", arguments: { command: "cat /home/agent/in.txt" } });
    expect(textOf(cat)).toContain("hello from the host");
    await client.callTool({ name: "desktop_exec", arguments: { command: "echo -n generated > /home/agent/out.txt" } });
    const get = await client.callTool({ name: "file_get", arguments: { desktop_path: "/home/agent/out.txt", host_path: path.join(hostDir, "out.txt") } });
    expect(get.isError, textOf(get)).toBeFalsy();
    expect(fs.readFileSync(path.join(hostDir, "out.txt"), "utf8")).toBe("generated");
    expect(fs.statSync(path.join(hostDir, "out.txt")).uid).toBe(1000);
    const denied = await client.callTool({ name: "file_put", arguments: { host_path: "/var/run/docker.sock", desktop_path: "/tmp/x" } });
    expect(textOf(denied)).toContain("mount_refused");
    // Session end removes this session's desktop container.
    await transport.terminateSession();
    await waitFor(async () => !(await ours()).some((c) => c.Labels[LABELS.id] === id), { what: "container removed", timeout: 30_000 });
  });

  it("stops, restarts and removes through the API", async () => {
    const stop = await api(t, "POST", `/api/desktops/${deskId}/stop`);
    expect(stop.data.status).toBe("stopped");
    await waitFor(async () => (await ours()).find((x) => x.Labels[LABELS.id] === deskId)?.State === "exited", { what: "container exited", timeout: 20_000 });
    const startRes = await api(t, "POST", `/api/desktops/${deskId}/start`);
    expect(startRes.data.status).toBe("running");
    const shot = await fetch(`${t.url}/api/desktops/${deskId}/thumbnail`, { headers: { authorization: `Bearer ${t.token}` } });
    expect(shot.headers.get("content-type")).toBe("image/webp");
  });

  it("enforces the desktop limit", async () => {
    const { client } = await connectMcp(t.url, t.token);
    const running = (await api(t, "GET", "/api/desktops")).data.desktops.filter((d: { status: string }) => d.status === "running").length;
    for (let i = running; i < 3; i++) idOf(await client.callTool({ name: "desktop_start", arguments: {} }));
    const over = await client.callTool({ name: "desktop_start", arguments: {} });
    expect(textOf(over)).toContain("limit_reached");
    // Clean up the extra desktops (the session is still open).
    for (const d of (await api(t, "GET", "/api/desktops")).data.desktops) if (d.id !== deskId) await api(t, "DELETE", `/api/desktops/${d.id}`);
    await client.close();
  });

  it("a restarted manager (even with a fresh database) rediscovers desktops by label", async () => {
    await t.close();
    managers.splice(managers.indexOf(t), 1);
    const t2 = await start({}, `${instance}-1`);
    const d = (await api(t2, "GET", `/api/desktops/${deskId}`)).data;
    expect(d).toMatchObject({ id: deskId, status: "running", template: "base", title: "docker one" });
    expect(d.mounts).toEqual([{ path: path.join(hostDir, "work") }]);
    const shot = await fetch(`${t2.url}/api/desktops/${deskId}/screenshot`, { headers: { authorization: `Bearer ${t2.token}` } });
    expect(shot.status).toBe(200);
    expect((await api(t2, "DELETE", `/api/desktops/${deskId}`)).status).toBe(204);
    expect((await ours()).some((c) => c.Labels[LABELS.id] === deskId)).toBe(false);
    t = t2;
  });

  it("stops idle desktops (files kept) and restarts them on the next tool call with a note", async () => {
    const t3 = await start({ DESKHAND_IDLE_TIMEOUT: "2s" });
    const { client, transport } = await connectMcp(t3.url, t3.token);
    const s = await client.callTool({ name: "desktop_start", arguments: {} });
    const id = idOf(s);
    await client.callTool({ name: "desktop_exec", arguments: { command: "echo kept > /home/agent/keep.txt" } });
    await waitFor(async () => (await ours()).find((c) => c.Labels[LABELS.id] === id)?.State === "exited", { what: "idle stop", timeout: 30_000, interval: 250 });
    const r = await client.callTool({ name: "desktop_exec", arguments: { command: "cat /home/agent/keep.txt" } });
    expect(textOf(r)).toContain("This desktop was stopped after 2 seconds idle and restarted; open windows were closed, files are kept.");
    expect(textOf(r)).toContain("kept");
    await transport.terminateSession();
    await waitFor(async () => !(await ours()).some((c) => c.Labels[LABELS.id] === id), { what: "session end removal", timeout: 30_000 });
  });

  it("reports image_pull_failed for an image that cannot be pulled", async () => {
    const t4 = await start({ DESKHAND_DESKTOP_IMAGE: `deskhand-dev-nonexistent-${instance}/desktop:dev` });
    const { client } = await connectMcp(t4.url, t4.token);
    const r = await client.callTool({ name: "desktop_start", arguments: {} });
    expect(textOf(r)).toContain("image_pull_failed");
    await client.close();
  });
});
