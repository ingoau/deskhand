/**
 * Phase 6 opt-in hardware end-to-end against the real desktop image:
 *   DEV_DOCKER=1 scripts/dev env DESKHAND_E2E_IMAGE=deskhand-desktop:dev-kvm pnpm --filter @deskhand/manager \
 *     exec vitest run test/e2e/hardware.e2e.test.ts
 * - desktop_start(kvm: true, memory: "4g", cpus: 2): the container's HostConfig has /dev/kvm as a device and
 *   the limits; the agent user opens /dev/kvm read/write and KVM_GET_API_VERSION returns 12 — from
 *   desktop_exec, and from an xterm started from the panel (pixel click), i.e. a process tree that
 *   descends from tint2/supervisord rather than the daemon.
 * - The host's /dev/kvm keeps its owner and mode.
 * - A desktop without kvm has no /dev/kvm and no device in its HostConfig.
 * KVM checks are skipped when the Docker host has no /dev/kvm. Everything is labelled owner=deskhand-dev
 * with a per-run instance and removed afterwards.
 */
import Docker from "dockerode";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LABELS } from "@deskhand/shared";
import { connectMcp, startManager, textOf, waitFor, type TestManager } from "../helpers.js";

const IMAGE = process.env.DESKHAND_E2E_IMAGE ?? "deskhand-desktop:dev";
const docker = new Docker();
const instance = `k${Math.random().toString(36).slice(2, 8)}`;
const network = `deskhand-e2e-${instance}`;
const GB = 1024 ** 3;

let t: TestManager;
let client: Client;
let terminate: () => Promise<void>;
let hostHasKvm = false;

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  return { r, text: textOf(r), isError: !!r.isError };
}

async function exec(desktop: string, command: string, timeout = 30): Promise<{ stdout: string; text: string }> {
  const { text, isError } = await call("desktop_exec", { command, timeout, desktop });
  expect(isError, text).toBe(false);
  const m = /stdout:\n([\s\S]*?)(?:\nstderr:|$)/.exec(text);
  return { stdout: m ? m[1]!.trim() : "", text };
}

const KVM_PROBE = `python3 -c "import os,fcntl; fd=os.open('/dev/kvm', os.O_RDWR); print('KVM_API', fcntl.ioctl(fd, 0xAE00)); print('UID', os.getuid(), 'GID', os.getgid(), 'GROUPS', os.getgroups())"`;

async function containerOf(desktopId: string) {
  const list = await docker.listContainers({ all: true, filters: { label: [`${LABELS.instance}=${instance}`, `${LABELS.id}=${desktopId}`] } });
  expect(list).toHaveLength(1);
  return docker.getContainer(list[0]!.Id).inspect();
}

/** uid:gid:mode of the Docker host's /dev/kvm (null when absent), read by a throwaway helper (the test runner may be in a container). */
async function hostKvmStat(): Promise<string | null> {
  const c = await docker.createContainer({
    Image: "busybox:1.37",
    Cmd: ["sh", "-c", "if [ -c /hostdev/kvm ]; then stat -c %u:%g:%a /hostdev/kvm; else echo none; fi"],
    Labels: { owner: "deskhand-dev", [LABELS.instance]: instance },
    HostConfig: { Binds: ["/dev:/hostdev:ro"], NetworkMode: "none" },
  });
  try {
    await c.start();
    await c.wait();
    const logs = (await c.logs({ stdout: true, stderr: false })) as unknown as Buffer;
    const out = logs.subarray(8).toString("utf8").trim();
    return out === "none" ? null : out;
  } finally {
    await c.remove({ force: true }).catch(() => undefined);
  }
}

beforeAll(async () => {
  await docker.getImage(IMAGE).inspect(); // fail fast if the image isn't built
  hostHasKvm = (await hostKvmStat()) !== null;
  t = await startManager({
    env: {
      DESKHAND_RUNTIME: "docker",
      DESKHAND_OWNER_LABEL: "deskhand-dev",
      DESKHAND_INSTANCE: instance,
      DESKHAND_NETWORK: network,
      DESKHAND_DESKTOP_IMAGE: IMAGE,
      DESKHAND_CONTAINER_PREFIX: `dhe2e-${instance}-`,
      DESKHAND_MAX_DESKTOPS: "2",
      DESKHAND_HEALTH_INTERVAL: "1s",
      DESKHAND_START_TIMEOUT: "90s",
    },
  });
  const c = await connectMcp(t.url, t.token, "hardware-e2e");
  client = c.client;
  terminate = () => c.transport.terminateSession();
}, 180_000);

afterAll(async () => {
  await terminate?.().catch(() => undefined);
  await t?.close().catch(() => undefined);
  const all = await docker.listContainers({ all: true, filters: { label: ["owner=deskhand-dev", `${LABELS.instance}=${instance}`] } });
  for (const c of all) await docker.getContainer(c.Id).remove({ force: true }).catch(() => undefined);
  await docker.getNetwork(network).remove().catch(() => undefined);
}, 120_000);

describe("opt-in hardware on the real desktop image", { timeout: 240_000 }, () => {
  it("detects KVM on the Docker host", async () => {
    const sys = (await fetch(`${t.url}/api/system`, { headers: { authorization: `Bearer ${t.token}` } }).then((r) => r.json())) as { hardware: { kvm: string } };
    expect(sys.hardware.kvm).toBe(hostHasKvm ? "available" : "unavailable");
  });

  it("kvm: true + 4g/2 CPUs: device and limits in HostConfig; the agent opens /dev/kvm (exec and a panel-started terminal)", async () => {
    if (!hostHasKvm) {
      const r = await call("desktop_start", { kvm: true });
      expect(r.text).toContain("kvm_unavailable");
      return;
    }
    const hostBefore = await hostKvmStat();
    const s = await call("desktop_start", { kvm: true, memory: "4g", cpus: 2, name: "kvm-e2e" });
    expect(s.isError, s.text).toBe(false);
    expect(s.text).toContain("4g memory, 2 CPUs, kvm");
    const id = /Desktop (\w+) is ready/.exec(s.text)![1]!;

    const info = await containerOf(id);
    expect(info.HostConfig.Memory).toBe(4 * GB);
    expect(info.HostConfig.NanoCpus).toBe(2e9);
    expect(info.HostConfig.Devices).toEqual([expect.objectContaining({ PathOnHost: "/dev/kvm", PathInContainer: "/dev/kvm", CgroupPermissions: "rwm" })]);

    // desktop_exec runs as agent via Node spawn (uid/gid set, supplementary groups dropped).
    const viaExec = await exec(id, `ls -ln /dev/kvm; ${KVM_PROBE}`);
    expect(viaExec.stdout).toContain("KVM_API 12");
    expect(viaExec.stdout).toMatch(/UID 1000 GID 1000/);

    // A terminal started from the panel (tint2 launcher, pixel click): xterm -> bash -> python, as agent.
    await exec(id, "rm -f /tmp/kvm-panel.txt");
    const before = (await exec(id, "pgrep -x xterm | wc -l")).stdout;
    expect(before).toBe("0");
    // xterm is the 7th launcher: panel padding 4 + launcher padding 2, 22 px icons 4 px apart, 30 px panel at the bottom.
    // tint2 ignores launcher clicks for a few seconds after the desktop starts, so retry the click.
    let xterm = "";
    for (let attempt = 0; attempt < 5 && !xterm; attempt++) {
      const click = await call("left_click", { coordinate: [4 + 2 + 6 * 26 + 11, 800 - 15], desktop: id });
      expect(click.isError, click.text).toBe(false);
      expect(click.text, "the click was performed").not.toContain("not performed");
      xterm = await waitFor(async () => (await exec(id, "xdotool search --onlyvisible --class xterm | head -1")).stdout, { timeout: 6_000, interval: 500, what: "xterm window" }).catch(() => "");
    }
    if (!xterm) {
      const diag = await exec(id, "ps -eo pid,ppid,user,pcpu,etime,args; grep 'open files' /proc/$(pgrep -x tint2 | head -1)/limits");
      throw new Error(`no xterm after clicking the panel launcher\n${diag.text}`);
    }
    // Ancestry of the xterm: started by the panel (tint2 -> sh -> xterm), not by the daemon.
    const tree = (await exec(id, 'p=$(pgrep -xo xterm); while [ "$p" -gt 1 ]; do ps -o user=,comm= -p $p | tr -s " "; p=$(ps -o ppid= -p $p | tr -d " "); done')).stdout;
    expect(tree).toMatch(/agent xterm[\s\S]*agent tint2/);
    expect(tree).not.toContain("node");
    await exec(id, "xdotool search --onlyvisible --class xterm | head -1 | xargs -r xdotool windowactivate --sync");
    const typed = await call("type", { text: `${KVM_PROBE} > /tmp/kvm-panel.txt 2>&1\n`, desktop: id });
    expect(typed.isError, typed.text).toBe(false);
    const out = await waitFor(
      async () => {
        const r = await exec(id, "cat /tmp/kvm-panel.txt 2>/dev/null");
        return r.stdout.includes("KVM_API") ? r.stdout : "";
      },
      { timeout: 20_000, interval: 500, what: "probe output from the panel terminal" },
    );
    expect(out).toContain("KVM_API 12");
    expect(out).toMatch(/UID 1000 GID 1000/);

    // The host's device node is untouched (the entrypoint only changes the container's own /dev).
    expect(await hostKvmStat()).toBe(hostBefore);
    expect(hostBefore).not.toMatch(/^\d+:1000:/);
    await call("desktop_stop", { desktop: id });
  });

  it("a desktop without kvm has no /dev/kvm", async () => {
    const s = await call("desktop_start", { name: "plain-e2e" });
    expect(s.isError, s.text).toBe(false);
    const id = /Desktop (\w+) is ready/.exec(s.text)![1]!;
    const info = await containerOf(id);
    expect(info.HostConfig.Devices ?? []).toEqual([]);
    expect(info.HostConfig.Memory).toBe(2 * GB);
    const r = await exec(id, "test -e /dev/kvm && echo present || echo absent");
    expect(r.stdout).toBe("absent");
    await call("desktop_stop", { desktop: id });
  });
});
