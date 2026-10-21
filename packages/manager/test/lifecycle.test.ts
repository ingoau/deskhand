import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { LABELS } from "@deskhand/shared";
import { FakeRuntime } from "../src/runtime/fake.js";
import { api, connectMcp, imagesOf, startManager, textOf, tmpDir, waitFor, type TestManager } from "./helpers.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f().catch(() => undefined);
});

async function manager(opts: Parameters<typeof startManager>[0] = {}): Promise<TestManager> {
  const t = await startManager(opts);
  cleanup.push(async () => {
    await t.close();
    if (!opts.runtime) await (t.runtime as FakeRuntime).destroy();
  });
  return t;
}

describe("desktop lifecycle (fake runtime)", () => {
  it("creates, lists, stops, starts and removes desktops through the API, with labels", async () => {
    const t = await manager({ env: { TZ: "Australia/Sydney", LANG: "en_AU.UTF-8" } });
    const c = await api(t, "POST", "/api/desktops", { name: "from dashboard" });
    expect(c.status).toBe(201);
    const id = c.data.id;
    await waitFor(async () => (await api(t, "GET", `/api/desktops/${id}`)).data.status === "running", { what: "running" });
    const list = await api(t, "GET", "/api/desktops");
    expect(list.data.desktops.map((d: { id: string }) => d.id)).toEqual([id]);
    const rt = t.runtime as FakeRuntime;
    const spec = [...rt.containers.values()][0]!.spec;
    expect(spec.labels).toMatchObject({ [LABELS.id]: id, [LABELS.template]: "base", [LABELS.templateVersion]: "1", [LABELS.persistent]: "false", [LABELS.title]: "from dashboard" });
    expect(spec.labels[LABELS.created]).toBeTruthy();
    expect(spec.env).toMatchObject({ TZ: "Australia/Sydney", LANG: "en_AU.UTF-8", DESKHAND_SCREEN: "1280x800" });
    expect(spec.env.DESKHAND_DAEMON_KEY).toHaveLength(43);
    expect(spec.memoryBytes).toBe(2 * 1024 ** 3);
    expect(spec.cpus).toBe(1.5);

    const thumb = await fetch(`${t.url}/api/desktops/${id}/thumbnail`, { headers: { authorization: `Bearer ${t.token}` } });
    expect(thumb.headers.get("content-type")).toBe("image/webp");
    expect(thumb.headers.get("cache-control")).toBe("no-store");
    const shot = await fetch(`${t.url}/api/desktops/${id}/screenshot`, { headers: { authorization: `Bearer ${t.token}` } });
    expect(shot.headers.get("content-type")).toBe("image/png");

    expect((await api(t, "POST", `/api/desktops/${id}/stop`)).data.status).toBe("stopped");
    expect((await api(t, "POST", `/api/desktops/${id}/start`)).data.status).toBe("running");
    expect((await api(t, "POST", `/api/desktops/${id}/persistent`, { persistent: true })).data.persistent).toBe(true);
    expect((await api(t, "DELETE", `/api/desktops/${id}`)).status).toBe(204);
    expect((await api(t, "GET", `/api/desktops/${id}`)).status).toBe(404);
    expect(rt.containers.size).toBe(0);
    const sys = await api(t, "GET", "/api/system");
    expect(sys.data).toMatchObject({ running: 0, maxDesktops: 8, auth: true });
  });

  it("refuses desktops over the count or memory budget with limit_reached", async () => {
    const t = await manager({ env: { DESKHAND_MEMORY_BUDGET: "5g", DESKHAND_DESKTOP_MEMORY: "2g" } });
    expect((await api(t, "POST", "/api/desktops", {})).status).toBe(201);
    expect((await api(t, "POST", "/api/desktops", {})).status).toBe(201);
    const third = await api(t, "POST", "/api/desktops", {});
    expect(third.status).toBe(429);
    expect(third.data.error.code).toBe("limit_reached");
    expect(third.data.error.message).toContain("memory budget");
  });

  it("maps engine failures to docker_unavailable, image_pull_failed and version_mismatch", async () => {
    const t = await manager();
    const rt = t.runtime as FakeRuntime;
    rt.dockerDown = true;
    expect((await api(t, "POST", "/api/desktops", {})).data.error.code).toBe("docker_unavailable");
    rt.dockerDown = false;
    rt.images.clear();
    rt.unpullable.add(t.m.cfg.desktopImage);
    expect((await api(t, "POST", "/api/desktops", {})).data.error.code).toBe("image_pull_failed");
    rt.unpullable.clear();
    rt.diskFull = true;
    expect((await api(t, "POST", "/api/desktops", {})).data.error.code).toBe("disk_full");

    const t2 = await manager({ fake: { apiVersion: 99 } });
    const { client } = await connectMcp(t2.url, t2.token);
    const r = await client.callTool({ name: "desktop_start", arguments: {} });
    expect(textOf(r)).toContain("version_mismatch");
    expect((t2.runtime as FakeRuntime).containers.size).toBe(0);
    await client.close();
  });

  it("rediscovers desktops after a manager restart, even without its database", async () => {
    const runtime = new FakeRuntime({ lockWaitMs: 500 });
    cleanup.push(() => runtime.destroy());
    const dataDir = tmpDir();
    const t1 = await startManager({ runtime, dataDir });
    const id = (await api(t1, "POST", "/api/desktops", { name: "survivor", persistent: true })).data.id;
    await waitFor(() => t1.m.desktops.get(id)?.status === "running");
    await t1.close({ keepData: true });
    expect(runtime.containers.size).toBe(1); // the manager does not stop desktops on shutdown

    const t2 = await manager({ runtime, dataDir });
    const d = (await api(t2, "GET", `/api/desktops/${id}`)).data;
    expect(d).toMatchObject({ id, status: "running", title: "survivor", persistent: true });
    await t2.close({ keepData: true });
    cleanup.pop();

    const t3 = await manager({ runtime }); // fresh data dir: imported from labels
    const d3 = (await api(t3, "GET", `/api/desktops/${id}`)).data;
    expect(d3).toMatchObject({ id, status: "running", persistent: true, template: "base" });
    // And it is usable: the daemon key came from the container's env.
    const shotRes = await fetch(`${t3.url}/api/desktops/${id}/screenshot`, { headers: { authorization: `Bearer ${t3.token}` } });
    expect(shotRes.status, await shotRes.clone().text()).toBe(200);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("resumes an MCP session after a manager restart, keeping its desktops", async () => {
    const runtime = new FakeRuntime({ lockWaitMs: 500 });
    cleanup.push(() => runtime.destroy());
    const dataDir = tmpDir();
    cleanup.push(async () => fs.rmSync(dataDir, { recursive: true, force: true }));
    const t1 = await startManager({ runtime, dataDir });
    const a = await connectMcp(t1.url, t1.token);
    const id = /Desktop (\w+) is ready/.exec(textOf(await a.client.callTool({ name: "desktop_start", arguments: {} })))![1]!;
    const sessionId = a.transport.sessionId!;
    await t1.close({ keepData: true });
    expect(runtime.containers.size).toBe(1); // ephemeral desktops survive a manager restart

    const t2 = await manager({ runtime, dataDir });
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const transport = new StreamableHTTPClientTransport(new URL(`${t2.url}/mcp`), { sessionId, requestInit: { headers: { Authorization: `Bearer ${t1.token}` } } });
    const client = new Client({ name: "resumed", version: "1" });
    await client.connect(transport);
    const list = JSON.parse(textOf(await client.callTool({ name: "desktop_list", arguments: {} })));
    expect(list.map((d: { id: string }) => d.id)).toEqual([id]);
    const shot = await client.callTool({ name: "screenshot", arguments: {} });
    expect(shot.isError).toBeFalsy();
    // Another token cannot take over the session.
    const other = await fetch(`${t2.url}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${t2.token}`, "mcp-session-id": sessionId, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(other.status).toBe(404);
    await transport.terminateSession();
    await waitFor(() => t2.m.desktops.get(id) === undefined, { what: "removed on session end" });
  });

  it("stops idle desktops, and the next tool call restarts them with a note", async () => {
    const t = await manager({ env: { DESKHAND_IDLE_TIMEOUT: "600ms" } });
    const { client } = await connectMcp(t.url, t.token);
    const id = /Desktop (\w+) is ready/.exec(textOf(await client.callTool({ name: "desktop_start", arguments: {} })))![1]!;
    await waitFor(() => t.m.desktops.get(id)?.status === "stopped", { what: "idle stop" });
    expect(t.m.desktops.get(id)!.stopReason).toBe("idle");
    const r = await client.callTool({ name: "left_click", arguments: { coordinate: [3, 3] } });
    expect(textOf(r)).toMatch(/This desktop was stopped after [\w.]+ seconds? idle and restarted; open windows were closed, files are kept\./);
    expect(textOf(r)).toContain("was not performed");
    expect(imagesOf(r)).toHaveLength(1);
    expect(t.m.desktops.get(id)!.status).toBe("running");
    await client.close();
  });

  it("removes stopped ephemeral desktops after retention and recreates them with a note", async () => {
    const t = await manager({ env: { DESKHAND_IDLE_TIMEOUT: "300ms", DESKHAND_STOPPED_RETENTION: "300ms" } });
    const { client } = await connectMcp(t.url, t.token);
    const id = /Desktop (\w+) is ready/.exec(textOf(await client.callTool({ name: "desktop_start", arguments: { name: "keep-me" } })))![1]!;
    await waitFor(() => t.m.desktops.getAny(id)?.status === "removed", { what: "retention removal" });
    expect(t.m.desktops.getAny(id)!.removeReason).toBe("retention");
    const r = await client.callTool({ name: "screenshot", arguments: {} });
    expect(textOf(r)).toContain(`Your previous desktop ${id} was removed`);
    expect(textOf(r)).toContain("files from the old desktop are gone");
    expect(t.m.desktops.get(id)!.status).toBe("running");
    expect(t.m.desktops.get(id)!.title).toBe("keep-me");
    await client.close();
  });

  it("recreates a stopped desktop on the updated desktop image after an upgrade, keeping /home/agent", async () => {
    const t = await manager();
    const rt = t.runtime as FakeRuntime;
    const { client } = await connectMcp(t.url, t.token);
    const id = /Desktop (\w+) is ready/.exec(textOf(await client.callTool({ name: "desktop_start", arguments: { persistent: true } })))![1]!;
    const oldCid = t.m.desktops.get(id)!.containerId!;
    const oldRoot = [...rt.containers.values()].find((c) => c.id === oldCid)!.filesRoot;
    fs.mkdirSync(path.join(oldRoot, "home/agent/.cache"), { recursive: true });
    fs.writeFileSync(path.join(oldRoot, "home/agent/notes.txt"), "keep me");
    fs.writeFileSync(path.join(oldRoot, "home/agent/.cache/junk"), "x");
    expect((await api(t, "POST", `/api/desktops/${id}/stop`)).data.status).toBe("stopped");

    // Same image, nothing to do: the old container is started again.
    expect((await api(t, "POST", `/api/desktops/${id}/start`)).data.status).toBe("running");
    expect(t.m.desktops.get(id)!.containerId).toBe(oldCid);
    await api(t, "POST", `/api/desktops/${id}/stop`);

    // `docker compose pull` brought a new desktop image under the same tag.
    rt.imageIds.set(t.m.cfg.desktopImage, "sha256:new-desktop-image");
    const r = await client.callTool({ name: "screenshot", arguments: {} });
    expect(textOf(r)).toContain("now runs the new desktop image; everything in /home/agent was kept");
    const d = t.m.desktops.get(id)!;
    expect(d).toMatchObject({ status: "running", persistent: true });
    expect(d.containerId).not.toBe(oldCid);
    expect(rt.containers.has(oldCid)).toBe(false);
    const fresh = rt.containers.get(d.containerId!)!;
    expect(fresh.imageId).toBe("sha256:new-desktop-image");
    expect(fresh.spec.name).toBe(d.name);
    expect(fresh.spec.labels[LABELS.id]).toBe(id);
    expect(fs.readFileSync(path.join(fresh.filesRoot, "home/agent/notes.txt"), "utf8")).toBe("keep me");
    expect(fs.existsSync(path.join(fresh.filesRoot, "home/agent/.cache/junk"))).toBe(false);
    expect((await api(t, "GET", `/api/desktops/${id}/log`)).data.entries.some((e: { summary: string }) => e.summary.includes("updated image"))).toBe(true);
    await client.close();
  });

  it("keeps the old container when recreating on a new image fails", async () => {
    const t = await manager();
    const rt = t.runtime as FakeRuntime;
    const id = (await api(t, "POST", "/api/desktops", {})).data.id;
    await waitFor(() => t.m.desktops.get(id)?.status === "running");
    const oldCid = t.m.desktops.get(id)!.containerId!;
    await api(t, "POST", `/api/desktops/${id}/stop`);
    rt.imageIds.set(t.m.cfg.desktopImage, "sha256:new-desktop-image");
    rt.copyDir = async () => {
      throw new Error("copy failed");
    };
    expect((await api(t, "POST", `/api/desktops/${id}/start`)).data.status).toBe("running");
    const d = t.m.desktops.get(id)!;
    expect(d.containerId).toBe(oldCid);
    expect(rt.containers.size).toBe(1);
    expect(rt.containers.get(oldCid)!.spec.name).toBe(d.name);
  });

  it("cleans up a container left parked by an interrupted image upgrade", async () => {
    const runtime = new FakeRuntime({ lockWaitMs: 500 });
    cleanup.push(() => runtime.destroy());
    const dataDir = tmpDir();
    cleanup.push(async () => fs.rmSync(dataDir, { recursive: true, force: true }));
    const t1 = await startManager({ runtime, dataDir });
    const id = (await api(t1, "POST", "/api/desktops", {})).data.id;
    await waitFor(() => t1.m.desktops.get(id)?.status === "running");
    await api(t1, "POST", `/api/desktops/${id}/stop`);
    const d = t1.m.desktops.get(id)!;
    await t1.close({ keepData: true });
    // Simulate a crash after the rename and create, before the copy finished: the new one never started.
    await runtime.rename(d.containerId!, `${d.name}-replaced-abc`);
    const spec = [...runtime.containers.values()][0]!.spec;
    await runtime.createDesktop({ ...spec, name: d.name });
    expect(runtime.containers.size).toBe(2);
    const t2 = await manager({ runtime, dataDir });
    expect(runtime.containers.size).toBe(1);
    expect(runtime.containers.get(d.containerId!)!.spec.name).toBe(d.name);
    expect(t2.m.desktops.get(id)!.containerId).toBe(d.containerId);
  });

  it("restarts a desktop whose daemon stays unhealthy and tells the agent", async () => {
    const t = await manager({ env: { DESKHAND_UNHEALTHY_AFTER: "500ms" } });
    const { client } = await connectMcp(t.url, t.token);
    const id = /Desktop (\w+) is ready/.exec(textOf(await client.callTool({ name: "desktop_start", arguments: {} })))![1]!;
    const rt = t.runtime as FakeRuntime;
    const before = rt.daemonFor(id)!;
    before.behavior.unhealthy = true;
    await waitFor(() => rt.daemonFor(id) && rt.daemonFor(id) !== before && t.m.desktops.get(id)?.status === "running", { what: "restart" });
    const r = await client.callTool({ name: "screenshot", arguments: {} });
    expect(textOf(r)).toContain("stopped responding, so deskhand restarted it");
    await client.close();
  });

  it("notices a crashed container and restarts it on the next call", async () => {
    const t = await manager();
    const { client } = await connectMcp(t.url, t.token);
    const id = /Desktop (\w+) is ready/.exec(textOf(await client.callTool({ name: "desktop_start", arguments: {} })))![1]!;
    const rt = t.runtime as FakeRuntime;
    await rt.crash(t.m.desktops.get(id)!.containerId!);
    await waitFor(() => t.m.desktops.get(id)?.status === "stopped", { what: "exited detected" });
    const r = await client.callTool({ name: "cursor_position", arguments: {} });
    expect(textOf(r)).toContain("had stopped");
    await client.close();
  });

  it("ends idle MCP sessions, removing ephemeral desktops but keeping persistent ones for reattach", async () => {
    const t = await manager({ env: { DESKHAND_SESSION_TIMEOUT: "700ms", DESKHAND_IDLE_TIMEOUT: "1h" } });
    const a = await connectMcp(t.url, t.token);
    const eph = /Desktop (\w+) is ready/.exec(textOf(await a.client.callTool({ name: "desktop_start", arguments: {} })))![1]!;
    const per = /Desktop (\w+) is ready/.exec(textOf(await a.client.callTool({ name: "desktop_start", arguments: { name: "mine", persistent: true } })))![1]!;
    await waitFor(() => t.m.desktops.get(eph) === undefined, { what: "session timeout removal", timeout: 15_000 });
    expect(t.m.desktops.get(per)?.status).toBe("running");
    const b = await connectMcp(t.url, t.token);
    const r = await b.client.callTool({ name: "desktop_start", arguments: { name: "mine" } });
    expect(textOf(r)).toContain(`Reattached existing desktop ${per}`);
    const list = JSON.parse(textOf(await b.client.callTool({ name: "desktop_list", arguments: {} })));
    expect(list.map((d: { id: string }) => d.id)).toEqual([per]);
    const stop = await b.client.callTool({ name: "desktop_stop", arguments: {} });
    expect(textOf(stop)).toContain("stopped; its files are kept");
    expect(t.m.desktops.get(per)?.status).toBe("stopped");
    await b.client.close();
  });

  it("mounts host directories through the policy and copies files with file_put/file_get", async () => {
    const t = await manager();
    const host = tmpDir("deskhand-host-");
    cleanup.push(async () => fs.rmSync(host, { recursive: true, force: true }));
    fs.writeFileSync(path.join(host, "in.txt"), "from host");
    const { client } = await connectMcp(t.url, t.token);
    const s = await client.callTool({ name: "desktop_start", arguments: { mounts: [{ path: host }] } });
    expect(textOf(s)).toContain(`Mounted: ${host} (read-only)`);
    const spec = [...(t.runtime as FakeRuntime).containers.values()][0]!.spec;
    expect(spec.binds).toEqual([{ source: fs.realpathSync(host), target: host, write: false }]);
    const sock = await client.callTool({ name: "desktop_start", arguments: { mounts: [{ path: "/var/run/docker.sock" }] } });
    expect(textOf(sock)).toContain("mount_refused");

    const put = await client.callTool({ name: "file_put", arguments: { host_path: path.join(host, "in.txt"), desktop_path: "/home/agent/in.txt" } });
    expect(textOf(put)).toContain("Copied 9 bytes");
    const get = await client.callTool({ name: "file_get", arguments: { desktop_path: "/home/agent/in.txt", host_path: path.join(host, "out.txt") } });
    expect(get.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(host, "out.txt"), "utf8")).toBe("from host");
    await client.close();
  });

  it("uploads and downloads files from the dashboard and proxies the VNC websocket", async () => {
    const t = await manager();
    const id = (await api(t, "POST", "/api/desktops", {})).data.id;
    await waitFor(() => t.m.desktops.get(id)?.status === "running");
    const form = new FormData();
    form.set("path", "/home/agent/Downloads/");
    form.set("file", new Blob([Buffer.from("payload")]), "note.txt");
    const up = await fetch(`${t.url}/api/desktops/${id}/files`, { method: "POST", headers: { authorization: `Bearer ${t.token}` }, body: form });
    expect(await up.json()).toEqual({ path: "/home/agent/Downloads/note.txt", bytes: 7 });
    const down = await fetch(`${t.url}/api/desktops/${id}/files?path=/home/agent/Downloads/note.txt`, { headers: { authorization: `Bearer ${t.token}` } });
    expect(down.headers.get("content-disposition")).toBe('attachment; filename="note.txt"');
    expect(await down.text()).toBe("payload");

    const lock = await api(t, "POST", `/api/desktops/${id}/lock`, {});
    expect(lock.data).toMatchObject({ lock: { holder: "dashboard" } });
    expect((await api(t, "POST", `/api/desktops/${id}/lock`, {})).data.generation).toBe(lock.data.generation); // idempotent
    const origin = new URL(t.url).origin;
    const wsUrl = `${t.url.replace("http", "ws")}/api/desktops/${id}/vnc?mode=control&generation=${lock.data.generation}`;
    // Cross-origin websockets are refused.
    const bad = new WebSocket(wsUrl, ["binary"], { headers: { authorization: `Bearer ${t.token}`, origin: "https://evil.example" } });
    await expect(new Promise((res, rej) => (bad.on("open", res), bad.on("error", rej)))).rejects.toThrow(/403/);
    const ws = new WebSocket(wsUrl, ["binary"], { headers: { authorization: `Bearer ${t.token}`, origin } });
    const first = await new Promise<Buffer>((resolve, reject) => {
      ws.once("message", (d) => resolve(d as Buffer));
      ws.once("error", reject);
    });
    expect(first.toString()).toBe("RFB 003.008\n");
    expect(ws.protocol).toBe("binary");
    const next = () => new Promise<Buffer>((resolve) => ws.once("message", (d) => resolve(d as Buffer)));
    ws.send(Buffer.from("RFB 003.008\n"));
    expect([...(await next())]).toEqual([1, 1]); // security type None
    ws.send(Buffer.from([1]));
    expect([...(await next())]).toEqual([0, 0, 0, 0]);
    ws.send(Buffer.from([1])); // ClientInit (shared)
    const init = await next();
    expect([init.readUInt16BE(0), init.readUInt16BE(2)]).toEqual([1280, 800]);
    ws.send(Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61])); // KeyEvent 'a'
    const fake = (t.runtime as FakeRuntime).daemonFor(id)!;
    await waitFor(() => fake.vncInputs.length === 1);
    expect([...fake.vncInputs[0]!]).toEqual([4, 1, 0, 0, 0, 0, 0, 0x61]);
    ws.close();
    const unlock = await api(t, "DELETE", `/api/desktops/${id}/lock`, { note: null });
    expect(unlock.data).toEqual({ generation: lock.data.generation + 1, lock: null });
  });
});
