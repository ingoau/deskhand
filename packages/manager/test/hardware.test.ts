/** Phase 6: per-desktop memory/CPUs, KVM opt-in, templates remembering hardware (fake runtime). */
import { afterEach, describe, expect, it } from "vitest";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { parseConfig } from "../src/config.js";
import { FakeRuntime } from "../src/runtime/fake.js";
import { api, connectMcp, startManager, textOf, waitFor, type TestManager } from "./helpers.js";

const GB = 1024 ** 3;
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

function specOf(t: TestManager, desktopId: string) {
  const c = [...(t.runtime as FakeRuntime).containers.values()].find((x) => x.spec.id === desktopId);
  if (!c) throw new Error(`no container for ${desktopId}`);
  return c.spec;
}

const idOf = (text: string) => /Desktop (\w+) is ready/.exec(text)![1]!;

describe("hardware config", () => {
  it("parses the max memory/CPUs and DESKHAND_KVM with defaults", () => {
    const c = parseConfig({});
    expect(c.desktopMaxMemoryBytes).toBe(8 * GB);
    expect(c.desktopMaxCpus).toBe(4);
    expect(c.kvm).toBe("auto");
    const c2 = parseConfig({ DESKHAND_DESKTOP_MAX_MEMORY: "16g", DESKHAND_DESKTOP_MAX_CPUS: "6", DESKHAND_KVM: "OFF" });
    expect(c2).toMatchObject({ desktopMaxMemoryBytes: 16 * GB, desktopMaxCpus: 6, kvm: "off" });
    expect(() => parseConfig({ DESKHAND_KVM: "on" })).toThrow(/DESKHAND_KVM/);
    expect(() => parseConfig({ DESKHAND_DESKTOP_MAX_MEMORY: "1g" })).toThrow(/at least DESKHAND_DESKTOP_MEMORY/);
    expect(() => parseConfig({ DESKHAND_DESKTOP_MAX_CPUS: "1" })).toThrow(/at least DESKHAND_DESKTOP_CPUS/);
  });
});

describe("per-desktop memory and CPUs (fake runtime)", () => {
  it("passes memory/cpus to the container, reports them, and bounds them by the max", async () => {
    const t = await manager();
    const r = await api(t, "POST", "/api/desktops", { memory: "4g", cpus: 2 });
    expect(r.status).toBe(201);
    expect(r.data.hardware).toEqual({ memoryBytes: 4 * GB, cpus: 2, kvm: false });
    expect(specOf(t, r.data.id)).toMatchObject({ memoryBytes: 4 * GB, cpus: 2, kvm: false });

    const over = await api(t, "POST", "/api/desktops", { memory: "16g" });
    expect(over.status).toBe(400);
    expect(over.data.error.code).toBe("invalid_argument");
    expect(over.data.error.message).toContain("8 GB");
    const cpus = await api(t, "POST", "/api/desktops", { cpus: 6 });
    expect(cpus.data.error.code).toBe("invalid_argument");
    expect(cpus.data.error.message).toMatch(/cpus: 4 at most|has \d+ CPUs/);
    const bad = await api(t, "POST", "/api/desktops", { memory: "lots" });
    expect(bad.data.error.code).toBe("invalid_argument");
    const tiny = await api(t, "POST", "/api/desktops", { memory: "64m" });
    expect(tiny.data.error.message).toContain("at least 512m");

    const sys = await api(t, "GET", "/api/system");
    expect(sys.data.hardware).toMatchObject({ defaultMemoryBytes: 2 * GB, defaultCpus: 1.5, maxMemoryBytes: 8 * GB, kvm: "unavailable" });
  });

  it("MCP desktop_start takes memory/cpus, states the limits, and rejects over-max values with the limit", async () => {
    const t = await manager({ env: { DESKHAND_DESKTOP_MAX_MEMORY: "6g", DESKHAND_DESKTOP_MAX_CPUS: "3" } });
    const { client } = await connectMcp(t.url, t.token);
    const { tools } = await client.listTools();
    const desc = tools.find((x) => x.name === "desktop_start")!.description!;
    expect(desc).toContain("up to 6g memory and 3 CPUs per desktop");
    expect(desc).toContain("kvm: true");
    expect(client.getInstructions()).toContain("up to 6g memory and 3 CPUs per desktop");
    expect(client.getInstructions()).toContain("template_save");

    const ok = await client.callTool({ name: "desktop_start", arguments: { memory: "3g", cpus: 2.5 } });
    expect(ok.isError).toBeFalsy();
    expect(textOf(ok)).toContain("3g memory, 2.5 CPUs");
    const id = idOf(textOf(ok));
    expect(specOf(t, id)).toMatchObject({ memoryBytes: 3 * GB, cpus: 2.5 });
    const list = JSON.parse(textOf(await client.callTool({ name: "desktop_list", arguments: {} })));
    expect(list[0].hardware).toBe("3g memory, 2.5 CPUs");

    const over = await client.callTool({ name: "desktop_start", arguments: { memory: "7g" } });
    expect(over.isError).toBe(true);
    expect(textOf(over)).toContain("invalid_argument");
    expect(textOf(over)).toContain("6 GB");
    const overCpu = await client.callTool({ name: "desktop_start", arguments: { cpus: 4 } });
    expect(textOf(overCpu)).toContain("invalid_argument");
    expect(textOf(overCpu)).toContain("3");
    const badFormat = await client.callTool({ name: "desktop_start", arguments: { memory: "eight gigs" } });
    expect(textOf(badFormat)).toContain("invalid_argument");
    await client.close();
  });

  it("admission control budgets each desktop's own memory", async () => {
    const t = await manager({ env: { DESKHAND_MEMORY_BUDGET: "10g", DESKHAND_DESKTOP_MAX_MEMORY: "8g" } });
    const big = await api(t, "POST", "/api/desktops", { memory: "8g" });
    expect(big.status).toBe(201);
    // 8g used: a default 2g desktop still fits (10g), a third does not.
    expect((await api(t, "POST", "/api/desktops", {})).status).toBe(201);
    const third = await api(t, "POST", "/api/desktops", { memory: "1g" });
    expect(third.status).toBe(429);
    expect(third.data.error.code).toBe("limit_reached");
    expect(third.data.error.message).toContain("memory budget");
    expect(third.data.error.message).toContain("1 GB desktop");
    // Restarting a stopped big desktop is admitted by its own memory too.
    await waitFor(async () => (await api(t, "GET", `/api/desktops/${big.data.id}`)).data.status === "running", { what: "running" });
    await api(t, "POST", `/api/desktops/${big.data.id}/stop`);
    const small = await api(t, "POST", "/api/desktops", { memory: "2g" });
    expect(small.status).toBe(201);
    const restart = await api(t, "POST", `/api/desktops/${big.data.id}/start`);
    expect(restart.status).toBe(429);
    expect(restart.data.error.message).toContain("8 GB desktop");
  });

  it("restarts and recreations keep the desktop's hardware", async () => {
    const t = await manager({ env: { DESKHAND_IDLE_TIMEOUT: "300ms", DESKHAND_STOPPED_RETENTION: "300ms" }, fake: { kvm: true } });
    const { client } = await connectMcp(t.url, t.token);
    const id = idOf(textOf(await client.callTool({ name: "desktop_start", arguments: { memory: "5g", cpus: 3, kvm: true } })));
    const firstSpec = specOf(t, id);
    await waitFor(() => t.m.desktops.getAny(id)?.status === "removed", { what: "retention removal" });
    const r = await client.callTool({ name: "screenshot", arguments: {} });
    expect(textOf(r)).toContain(`Your previous desktop ${id} was removed`);
    const spec = specOf(t, id);
    expect(spec).not.toBe(firstSpec);
    expect(spec).toMatchObject({ memoryBytes: 5 * GB, cpus: 3, kvm: true });
    expect(t.m.desktops.get(id)!.hardware).toEqual({ memoryBytes: 5 * GB, cpus: 3, kvm: true });
    await client.close();
  });

  it("keeps hardware across a manager restart (DB columns) and imports it from containers", async () => {
    const runtime = new FakeRuntime({ lockWaitMs: 1000, kvm: true });
    cleanup.push(() => runtime.destroy());
    const t1 = await startManager({ runtime });
    const r = await api(t1, "POST", "/api/desktops", { memory: "3g", cpus: 1, kvm: true });
    await waitFor(async () => (await api(t1, "GET", `/api/desktops/${r.data.id}`)).data.status === "running", { what: "running" });
    await t1.close({ keepData: true });
    const t2 = await startManager({ runtime, dataDir: t1.dataDir });
    cleanup.push(() => t2.close());
    expect((await api(t2, "GET", `/api/desktops/${r.data.id}`)).data.hardware).toEqual({ memoryBytes: 3 * GB, cpus: 1, kvm: true });
    // A fresh DB rediscovers the container by label; hardware comes from its HostConfig.
    const t3 = await startManager({ runtime });
    cleanup.push(() => t3.close());
    expect((await api(t3, "GET", `/api/desktops/${r.data.id}`)).data.hardware).toEqual({ memoryBytes: 3 * GB, cpus: 1, kvm: true });
  });
});

describe("KVM opt-in (fake runtime)", () => {
  it("passes /dev/kvm when the Docker host has it, and caches the detection", async () => {
    const t = await manager({ fake: { kvm: true } });
    const rt = t.runtime as FakeRuntime;
    const { client } = await connectMcp(t.url, t.token);
    expect((await client.listTools()).tools.find((x) => x.name === "desktop_start")!.description).toContain("KVM available");
    const r = await client.callTool({ name: "desktop_start", arguments: { kvm: true } });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain("/dev/kvm is available to you");
    expect(specOf(t, idOf(textOf(r))).kvm).toBe(true);
    const plain = await client.callTool({ name: "desktop_start", arguments: {} });
    expect(specOf(t, idOf(textOf(plain))).kvm).toBe(false);
    await client.callTool({ name: "desktop_start", arguments: { kvm: true } });
    expect(rt.kvmChecks).toBe(1); // detected once at startup, then cached
    expect((await api(t, "GET", "/api/system")).data.hardware.kvm).toBe("available");
    await client.close();
  });

  it("returns kvm_unavailable when the host has no /dev/kvm", async () => {
    const t = await manager({ fake: { kvm: false } });
    const { client } = await connectMcp(t.url, t.token);
    const r = await client.callTool({ name: "desktop_start", arguments: { kvm: true, memory: "4g" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("kvm_unavailable");
    expect(textOf(r)).toContain("no KVM");
    expect(t.m.desktops.list()).toHaveLength(0);
    const viaApi = await api(t, "POST", "/api/desktops", { kvm: true });
    expect(viaApi.status).toBe(409);
    expect(viaApi.data.error.code).toBe("kvm_unavailable");
    await client.close();
  });

  it("returns kvm_unavailable when DESKHAND_KVM=off even if the host has it (never probes)", async () => {
    const t = await manager({ env: { DESKHAND_KVM: "off" }, fake: { kvm: true } });
    const rt = t.runtime as FakeRuntime;
    const r = await api(t, "POST", "/api/desktops", { kvm: true });
    expect(r.data.error.code).toBe("kvm_unavailable");
    expect(r.data.error.message).toContain("DESKHAND_KVM=off");
    expect(rt.kvmChecks).toBe(0);
    expect((await api(t, "GET", "/api/system")).data.hardware.kvm).toBe("disabled");
    const { client } = await connectMcp(t.url, t.token);
    expect(client.getInstructions()).toContain("KVM turned off on this host");
    await client.close();
  });
});

describe("templates remember hardware (fake runtime)", () => {
  it("records kvm/memory/cpus on save, defaults desktops to them, explicit args override", async () => {
    const t = await manager({ fake: { kvm: true } });
    const rt = t.runtime as FakeRuntime;
    const { client } = await connectMcp(t.url, t.token);
    let changed = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      changed++;
    });
    await client.callTool({ name: "desktop_start", arguments: { kvm: true, memory: "6g", cpus: 3 } });
    const save = await client.callTool({
      name: "template_save",
      arguments: { name: "emu", description: { summary: "Toolchain in ~/opt", use_when: "Running VMs" } },
    });
    expect(textOf(save)).toContain("Desktops started from it get kvm, 6g memory, 3 CPUs by default");
    await waitFor(() => changed > 0, { what: "tools/list_changed" });
    const desc = (await client.listTools()).tools.find((x) => x.name === "desktop_start")!.description!;
    expect(desc).toContain("emu: Toolchain in ~/opt. Use when: Running VMs [starts with kvm, 6g memory, 3 CPUs]");
    const list = JSON.parse(textOf(await client.callTool({ name: "template_list", arguments: {} })));
    expect(list.find((x: { name: string }) => x.name === "emu").hardware).toBe("kvm, 6g memory, 3 CPUs");
    expect(list.find((x: { name: string }) => x.name === "base").hardware).toBeUndefined();
    const info = JSON.parse(textOf(await client.callTool({ name: "template_info", arguments: { name: "emu" } })));
    expect(info.hardware).toEqual({ kvm: true, memoryBytes: 6 * GB, cpus: 3 });
    expect(info.versions[0].hardware).toEqual({ kvm: true, memoryBytes: 6 * GB, cpus: 3 });
    expect((await api(t, "GET", "/api/templates/emu")).data.hardware).toEqual({ kvm: true, memoryBytes: 6 * GB, cpus: 3 });

    const fromTpl = await client.callTool({ name: "desktop_start", arguments: { template: "emu" } });
    expect(fromTpl.isError).toBeFalsy();
    expect(specOf(t, idOf(textOf(fromTpl)))).toMatchObject({ memoryBytes: 6 * GB, cpus: 3, kvm: true });
    const override = await client.callTool({ name: "desktop_start", arguments: { template: "emu", kvm: false, memory: "3g" } });
    expect(specOf(t, idOf(textOf(override)))).toMatchObject({ memoryBytes: 3 * GB, cpus: 3, kvm: false });

    // Without KVM on the host, the template's kvm default is a clear error; kvm: false starts it.
    rt.kvm = false;
    (t.m.desktops.hardware as unknown as { kvmCache: unknown }).kvmCache = null;
    const noKvm = await client.callTool({ name: "desktop_start", arguments: { template: "emu" } });
    expect(noKvm.isError).toBe(true);
    expect(textOf(noKvm)).toContain("kvm_unavailable");
    expect(textOf(noKvm)).toContain("template emu was saved from a desktop with kvm; pass kvm: false");
    await client.close();
  });

  it("caps template defaults over the current max with a note, and records nothing for default desktops", async () => {
    const t = await manager({ env: { DESKHAND_DESKTOP_MAX_MEMORY: "8g" } });
    const { client } = await connectMcp(t.url, t.token);
    await client.callTool({ name: "desktop_start", arguments: {} });
    await client.callTool({ name: "template_save", arguments: { name: "plain", description: { summary: "Plain", use_when: "Anything" } } });
    expect((await api(t, "GET", "/api/templates/plain")).data.hardware).toBeNull();
    await client.callTool({ name: "desktop_start", arguments: { memory: "8g", name: "big" } });
    const big = t.m.desktops.list().find((d) => d.title === "big")!;
    await client.callTool({ name: "template_save", arguments: { name: "big", description: { summary: "Big", use_when: "Big jobs" }, desktop: big.id } });
    expect((await api(t, "GET", "/api/templates/big")).data.hardware).toEqual({ kvm: false, memoryBytes: 8 * GB, cpus: null });
    await client.close();

    // The admin lowers the max: desktops from the template get the max and are told so.
    await t.close({ keepData: true });
    const t2 = await manager({ dataDir: t.dataDir, env: { DESKHAND_DESKTOP_MAX_MEMORY: "4g" } });
    const c2 = (await connectMcp(t2.url, t2.token)).client;
    const r = await c2.callTool({ name: "desktop_start", arguments: { template: "big" } });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain("Template big asks for 8 GB of memory; this host allows 4 GB per desktop");
    expect(specOf(t2, idOf(textOf(r))).memoryBytes).toBe(4 * GB);
    await c2.close();
  });
});
