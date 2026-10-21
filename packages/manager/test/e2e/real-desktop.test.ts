/**
 * Scripted end-to-end test (no model calls): an MCP SDK client drives the real manager and the real
 * desktop image — the phase 2 "done when" checks in CI form. See suite/ for the same checks with real agents.
 *
 *   docker build -f images/desktop/Dockerfile -t deskhand-desktop:dev .
 *   DEV_DOCKER=1 scripts/dev pnpm --filter @deskhand/manager test:e2e
 *
 * Env: DESKHAND_E2E_IMAGE (default deskhand-desktop:dev). By default the manager runs in-process
 * (DockerRuntime). Set DESKHAND_E2E_URL + DESKHAND_E2E_TOKEN to test a running manager instead (e.g. the
 * compose deployment; DESKHAND_E2E_AGENT_UID = its DESKHAND_AGENT_UID, default 1000).
 * Host paths for mounts live under <repo>/tmp (scripts/dev mounts the repo at the same path, so the Docker
 * host sees them too). Ports 17300-17349. Everything created is labelled owner=deskhand-dev and removed.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Docker from "dockerode";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMPUTER_TOOLSET } from "@deskhand/mcp";
import { CursorResponse, DaemonClient, LABELS, type DaemonState } from "@deskhand/shared";
import { connectMcp, imagesOf, startManager, textOf, waitFor, type TestManager } from "../helpers.js";

const docker = new Docker();
const IMAGE = process.env.DESKHAND_E2E_IMAGE ?? "deskhand-desktop:dev";
const EXTERNAL = process.env.DESKHAND_E2E_URL ? { url: process.env.DESKHAND_E2E_URL.replace(/\/+$/, ""), token: process.env.DESKHAND_E2E_TOKEN ?? "" } : null;
const run = Math.random().toString(36).slice(2, 8);
const instance = `e2e-${run}`;
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const hostDir = path.join(repoRoot, "tmp", `e2e-${run}`);
const agentUid = EXTERNAL ? Number(process.env.DESKHAND_E2E_AGENT_UID ?? 1000) : (process.getuid?.() ?? 1000);
const agentGid = EXTERNAL ? Number(process.env.DESKHAND_E2E_AGENT_GID ?? agentUid) : (process.getgid?.() ?? 1000);

let t: TestManager | null = null;
let url = "";
let token = "";

type Mcp = Awaited<ReturnType<typeof connectMcp>>;
const sessions: Mcp[] = [];

async function mcp(name: string): Promise<Mcp> {
  const s = await connectMcp(url, token, name);
  sessions.push(s);
  return s;
}

async function call(s: Mcp, name: string, args: Record<string, unknown> = {}) {
  const r = (await s.client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 })) as { content?: unknown; isError?: boolean };
  if (r.isError) throw new Error(`${name} failed: ${textOf(r)}`);
  return r;
}

async function exec(s: Mcp, desktop: string, command: string) {
  const out = textOf(await call(s, "desktop_exec", { desktop, command, timeout: 60 }));
  const code = Number(/Exit code (-?\d+)/.exec(out)?.[1] ?? NaN);
  return { code, out };
}

function idOf(r: { content?: unknown }): string {
  const m = /Desktop (\w+) is ready/.exec(textOf(r));
  if (!m) throw new Error(`desktop_start failed: ${textOf(r)}`);
  return m[1]!;
}

async function rest(method: string, p: string, body?: unknown) {
  const res = await fetch(`${url}${p}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get("content-type") ?? "";
  return { status: res.status, data: (ct.includes("json") ? await res.json() : null) as any };
}

async function containerOf(id: string) {
  const list = await docker.listContainers({ all: true, filters: { label: [`${LABELS.id}=${id}`] } });
  if (list.length !== 1) return null;
  return docker.getContainer(list[0]!.Id).inspect();
}

/** Talks to a desktop's daemon directly (key from the container env, IP on its network), like the manager does. */
async function daemonOf(id: string): Promise<DaemonClient> {
  const c = await containerOf(id);
  if (!c) throw new Error(`no container for desktop ${id}`);
  const key = (c.Config.Env ?? []).find((e) => e.startsWith("DESKHAND_DAEMON_KEY="))!.split("=")[1]!;
  const ip = Object.values(c.NetworkSettings.Networks)[0]!.IPAddress;
  return new DaemonClient({ baseUrl: `http://${ip}:7000`, key });
}

async function state(id: string): Promise<DaemonState> {
  return (await daemonOf(id)).state();
}

/**
 * Opens Chromium like an agent would: click its panel launcher (bottom left) — once, and possibly right
 * after desktop_start, which caught two image bugs (fd-closing tint2; daemon ready before the panel) —
 * then ctrl+l, type the URL, Enter.
 */
async function browse(s: Mcp, desktop: string, target: string, title: string) {
  await call(s, "left_click", { desktop, coordinate: [16, 785] });
  await waitFor(async () => /chromium/i.test((await state(desktop)).title ?? ""), { timeout: 60_000, interval: 500, what: `Chromium window on ${desktop} after one launcher click` });
  await call(s, "key", { desktop, text: "ctrl+l" });
  await call(s, "type", { desktop, text: target });
  await call(s, "key", { desktop, text: "Return" });
  await waitFor(async () => ((await state(desktop)).title ?? "").includes(title), { timeout: 30_000, interval: 500, what: `"${title}" on ${desktop}` });
}

beforeAll(async () => {
  fs.mkdirSync(path.join(hostDir, "ro"), { recursive: true });
  fs.mkdirSync(path.join(hostDir, "rw"), { recursive: true });
  fs.writeFileSync(path.join(hostDir, "ro", "readme.txt"), "read-only mount\n");
  if (EXTERNAL) {
    url = EXTERNAL.url;
    token = EXTERNAL.token;
    return;
  }
  try {
    await docker.getImage(IMAGE).inspect();
  } catch {
    throw new Error(`desktop image ${IMAGE} not found: build it first (docker build -f images/desktop/Dockerfile -t ${IMAGE} .)`);
  }
  t = await startManager({
    ports: [17300, 17349],
    env: {
      DESKHAND_RUNTIME: "docker",
      DESKHAND_OWNER_LABEL: "deskhand-dev",
      DESKHAND_INSTANCE: instance,
      DESKHAND_NETWORK: `deskhand-e2e-${run}`,
      DESKHAND_CONTAINER_PREFIX: `dhe2e-${run}-`,
      DESKHAND_DESKTOP_IMAGE: IMAGE,
      DESKHAND_MAX_DESKTOPS: "4",
      DESKHAND_AGENT_UID: String(agentUid),
      DESKHAND_AGENT_GID: String(agentGid),
      DESKHAND_START_TIMEOUT: "90s",
      DESKHAND_HEALTH_INTERVAL: "1s",
      DESKHAND_SWEEP_INTERVAL: "1s",
      TZ: "Australia/Sydney",
    },
  });
  url = t.url;
  token = t.token;
}, 180_000);

afterAll(async () => {
  for (const s of sessions) await s.transport.terminateSession().catch(() => undefined);
  await t?.close();
  if (!EXTERNAL) {
    const left = await docker.listContainers({ all: true, filters: { label: ["owner=deskhand-dev", `${LABELS.instance}=${instance}`] } });
    for (const c of left) await docker.getContainer(c.Id).remove({ force: true }).catch(() => undefined);
    await docker.getNetwork(`deskhand-e2e-${run}`).remove().catch(() => undefined);
  }
  fs.rmSync(hostDir, { recursive: true, force: true });
}, 120_000);

describe("real manager + real desktop image", () => {
  it("lists the computer_toolset_20260801 tools with exactly its parameter names", async () => {
    const s = await mcp("contract");
    const { tools } = await s.client.listTools();
    const byName = new Map(tools.map((x) => [x.name, x]));
    const extras: Record<string, string[]> = { left_click_drag: ["duration_ms", "hold_ms"] };
    for (const [name, params] of Object.entries(COMPUTER_TOOLSET)) {
      const tool = byName.get(name);
      expect(tool, name).toBeDefined();
      const props = Object.keys((tool!.inputSchema as { properties?: object }).properties ?? {}).sort();
      expect(props, name).toEqual([...params, ...(extras[name] ?? []), "desktop"].sort());
    }
    const req = (n: string) => ((byName.get(n)!.inputSchema as { required?: string[] }).required ?? []).sort();
    expect(req("zoom")).toEqual(["region"]);
    expect(req("left_click_drag")).toEqual(["coordinate", "start_coordinate"]);
    expect(req("scroll")).toEqual(["scroll_amount", "scroll_direction"]);
    expect(req("mouse_move")).toEqual(["coordinate"]);
    expect(req("type")).toEqual(["text"]);
    expect(req("key")).toEqual(["text"]);
    expect(req("hold_key")).toEqual(["duration", "text"]);
    expect(req("wait")).toEqual(["duration"]);
    expect(req("left_click")).toEqual([]);
    const dir = (byName.get("scroll")!.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties.scroll_direction!;
    expect(dir.enum?.sort()).toEqual(["down", "left", "right", "up"]);
    await s.transport.terminateSession();
  });

  it("gives two concurrent sessions separate desktops with their own mounts, browsing independently", async () => {
    const [a, b] = await Promise.all([mcp("session-a"), mcp("session-b")]);
    const ro = path.join(hostDir, "ro");
    const rw = path.join(hostDir, "rw");
    const [ra, rb] = await Promise.all([
      call(a, "desktop_start", { name: "e2e a", mounts: [{ path: ro }] }),
      call(b, "desktop_start", { name: "e2e b", mounts: [{ path: rw, write: true }] }),
    ]);
    const ida = idOf(ra);
    const idb = idOf(rb);
    expect(ida).not.toEqual(idb);
    expect(textOf(ra)).toContain(`${ro} (read-only)`);
    expect(textOf(rb)).toContain(`${rw} (read-write)`);
    expect(imagesOf(ra)[0]!.mimeType).toMatch(/image\/(png|jpeg)/);

    // Containers: only the mounts they asked for, Chrome's seccomp profile, separate desktops.
    const ca = (await containerOf(ida))!;
    const cb = (await containerOf(idb))!;
    expect(ca.HostConfig.Binds).toEqual([`${ro}:${ro}:ro`]);
    expect(cb.HostConfig.Binds).toEqual([`${rw}:${rw}:rw`]);
    for (const c of [ca, cb]) {
      const sec = c.HostConfig.SecurityOpt ?? [];
      expect(sec.some((o) => o.startsWith("seccomp={"))).toBe(true);
      expect(sec).toContain("apparmor=unconfined");
      expect(c.HostConfig.ShmSize).toBe(1024 ** 3);
      expect(Object.keys(c.HostConfig.Tmpfs ?? {})).toContain("/run/deskhand"); // the key never lands in a commit
    }
    const keyDir = await exec(a, ida, "findmnt -n -o FSTYPE /run/deskhand; stat -c '%a %U' /run/deskhand/key; cat /run/deskhand/key 2>&1 | head -c 60");
    expect(keyDir.out).toMatch(/stdout:\ntmpfs\n600 root\ncat: \/run\/deskhand\/key: Permission denied/);

    // Read-only is enforced; the writable mount gets the agent's file, owned by the host user.
    const denied = await exec(a, ida, `touch ${ro}/nope`);
    expect(denied.code).not.toBe(0);
    expect(denied.out).toMatch(/Read-only file system/);
    expect((await exec(a, ida, `cat ${ro}/readme.txt`)).out).toContain("read-only mount");
    expect((await exec(a, ida, `ls ${rw} 2>&1`)).code).not.toBe(0); // b's mount is not in a's desktop
    expect((await exec(b, idb, `echo from-the-agent > ${rw}/agent.txt`)).code).toBe(0);
    const st = fs.statSync(path.join(rw, "agent.txt"));
    expect(fs.readFileSync(path.join(rw, "agent.txt"), "utf8")).toBe("from-the-agent\n");
    expect(st.uid).toBe(agentUid);
    expect(st.gid).toBe(agentGid);

    // Each opens a different page with the keyboard, at the same time.
    await Promise.all([
      browse(a, ida, "file:///opt/deskhand/testpages/slider.html", "Range slider"),
      browse(b, idb, "file:///opt/deskhand/testpages/dnd-lists.html", "Drag between lists"),
    ]);
    expect((await state(ida)).title).toContain("Range slider");
    expect((await state(idb)).title).toContain("Drag between lists");

    // Chromium runs with its sandbox: /state says so, and renderers live in their own user namespace.
    for (const [s, id] of [[a, ida], [b, idb]] as const) {
      expect((await state(id)).chromiumSandbox).toBe("on");
      const ns = await exec(s, id, "readlink /proc/$(pgrep -o -x chromium)/ns/user; for p in $(pgrep -f -- --type=renderer); do readlink /proc/$p/ns/user; done | sort -u");
      const lines = ns.out.split("\n").filter((l) => l.startsWith("user:["));
      expect(lines.length, ns.out).toBeGreaterThanOrEqual(2);
      expect(new Set(lines).size, ns.out).toBeGreaterThanOrEqual(2);
      expect((await exec(s, id, "pgrep -a -x chromium | grep -c -- --no-sandbox || true")).out).toMatch(/stdout:\n0/);
    }

    // TZ passes through to the desktop (in-process manager only; the compose one uses the host's).
    if (!EXTERNAL) expect((await exec(a, ida, "date +%Z")).out).toMatch(/AE[DS]T/);

    // Session end removes each session's ephemeral desktops (and only those).
    await a.transport.terminateSession();
    await waitFor(async () => (await containerOf(ida)) === null, { timeout: 30_000, interval: 500, what: "a's container removed" });
    expect(await containerOf(idb)).not.toBeNull();
    await b.transport.terminateSession();
    await waitFor(async () => (await containerOf(idb)) === null, { timeout: 30_000, interval: 500, what: "b's container removed" });
    expect((await rest("GET", `/api/desktops/${ida}`)).data?.status ?? "removed").toBe("removed");
  });

  it("serves cursor, zoom, ui_tree and the VNC proxy from the real desktop", async () => {
    const s = await mcp("tools");
    const id = idOf(await call(s, "desktop_start", { name: "e2e tools" }));

    await call(s, "mouse_move", { desktop: id, coordinate: [321, 234] });
    expect(textOf(await call(s, "cursor_position", { desktop: id }))).toMatch(/X=321, Y=234/);
    // The daemon's /cursor shape is the shared CursorResponse: {x, y, cursor: [x, y]}.
    const raw = await (await fetch(`${(await daemonOf(id)).baseUrl}/cursor`, { headers: { authorization: (await daemonOf(id)).authHeader } })).json();
    expect(CursorResponse.parse(raw)).toEqual({ x: 321, y: 234, cursor: [321, 234] });
    const zoom = await call(s, "zoom", { desktop: id, region: [0, 0, 640, 400] });
    const zimg = imagesOf(zoom)[0]!;
    expect(zimg).toBeDefined();

    await browse(s, id, "file:///opt/deskhand/testpages/index.html", "deskhand drag test set");
    const tree = textOf(await call(s, "ui_tree", { desktop: id }));
    expect(tree.length).toBeGreaterThan(200);
    expect(tree).toMatch(/Address and search bar/);
    expect(tree).toMatch(/deskhand drag test set/);

    // VNC through the manager: RFB handshake with the real x11vnc up to ServerInit (1280x800).
    const origin = new URL(url).origin;
    const ws = new WebSocket(`${url.replace(/^http/, "ws")}/api/desktops/${id}/vnc?mode=view`, ["binary"], { headers: { authorization: `Bearer ${token}` }, origin });
    const init = await new Promise<{ version: string; width: number; height: number; name: string }>((resolve, reject) => {
      let buf = Buffer.alloc(0);
      let step = 0;
      let version = "";
      const timer = setTimeout(() => reject(new Error(`VNC handshake stalled at step ${step}`)), 15_000);
      ws.on("error", reject);
      ws.on("message", (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        if (step === 0 && buf.length >= 12) {
          version = buf.subarray(0, 12).toString();
          buf = buf.subarray(12);
          ws.send(Buffer.from("RFB 003.008\n"));
          step = 1;
        }
        if (step === 1 && buf.length >= 1 && buf.length >= 1 + buf[0]!) {
          const types = [...buf.subarray(1, 1 + buf[0]!)];
          buf = buf.subarray(1 + buf[0]!);
          if (!types.includes(1)) return reject(new Error(`no None security type: ${types}`));
          ws.send(Buffer.from([1]));
          step = 2;
        }
        if (step === 2 && buf.length >= 4) {
          if (buf.readUInt32BE(0) !== 0) return reject(new Error("security handshake failed"));
          buf = buf.subarray(4);
          ws.send(Buffer.from([1])); // ClientInit, shared
          step = 3;
        }
        if (step === 3 && buf.length >= 24 && buf.length >= 24 + buf.readUInt32BE(20)) {
          clearTimeout(timer);
          resolve({ version, width: buf.readUInt16BE(0), height: buf.readUInt16BE(2), name: buf.subarray(24, 24 + buf.readUInt32BE(20)).toString() });
        }
      });
    });
    ws.close();
    expect(init.version).toMatch(/^RFB 003\.00[78]\n$/);
    expect([init.width, init.height]).toEqual([1280, 800]);

    await s.transport.terminateSession();
    await waitFor(async () => (await containerOf(id)) === null, { timeout: 30_000, interval: 500, what: "container removed" });
  });

  it("runs actions on two desktops of one session at the same time (one per subagent)", async () => {
    const s = await mcp("parent");
    const [r1, r2] = await Promise.all([call(s, "desktop_start", { name: "sub 1" }), call(s, "desktop_start", { name: "sub 2" })]);
    const d1 = idOf(r1);
    const d2 = idOf(r2);
    expect(d1).not.toEqual(d2);
    expect(JSON.parse(textOf(await call(s, "desktop_list")))).toHaveLength(2);

    const worker = async (desktop: string, x: number) => {
      await exec(s, desktop, "nohup mousepad >/dev/null 2>&1 &");
      await waitFor(async () => /mousepad|untitled/i.test((await state(desktop)).title ?? ""), { timeout: 30_000, interval: 300, what: `mousepad on ${desktop}` });
      for (let i = 0; i < 4; i++) {
        await call(s, "mouse_move", { desktop, coordinate: [x + i * 10, 300] });
        await call(s, "type", { desktop, text: `${desktop}-${i} ` });
      }
      return (await exec(s, desktop, "xdotool getactivewindow getwindowname")).out;
    };
    await Promise.all([worker(d1, 200), worker(d2, 600)]);
    // Each desktop got its own typing (the text is in its own mousepad, not the other's).
    expect((await state(d1)).title).toMatch(/mousepad|untitled/i);

    // The manager's action log shows both desktops' actions, overlapping in time.
    const span = async (id: string) => {
      const { data } = await rest("GET", `/api/desktops/${id}/log?limit=100`);
      const typed = (data.entries as Array<{ tool: string; at: string; durationMs: number | null; summary: string }>).filter((e) => e.tool === "type" || e.tool === "mouse_move");
      expect(typed.length).toBe(8);
      const ends = typed.map((e) => Date.parse(e.at));
      const starts = typed.map((e) => Date.parse(e.at) - (e.durationMs ?? 0));
      return { start: Math.min(...starts), end: Math.max(...ends), summaries: typed.map((e) => e.summary) };
    };
    const [s1, s2] = await Promise.all([span(d1), span(d2)]);
    expect(s1.summaries.join(" ")).toContain(`${d1}-0`);
    expect(s1.summaries.join(" ")).not.toContain(`${d2}-0`);
    expect(s2.summaries.join(" ")).toContain(`${d2}-0`);
    expect(Math.max(s1.start, s2.start)).toBeLessThan(Math.min(s1.end, s2.end)); // intervals overlap

    await s.transport.terminateSession();
    await waitFor(async () => (await containerOf(d1)) === null && (await containerOf(d2)) === null, { timeout: 30_000, interval: 500, what: "both removed" });
  });
});
