/**
 * Starts one deskhand-desktop:dev container for the e2e suite on a throwaway bridge network
 * (both labelled owner=deskhand-dev) and removes them afterwards. The tests reach the daemon at
 * the container's IP, which works from the scripts/dev container (host networking) on Linux.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";
import { containerLogs, docker, mustDocker } from "./docker.js";

declare module "vitest" {
  export interface ProvidedContext {
    daemonUrl: string;
    daemonKey: string;
    containerId: string;
  }
}

const IMAGE = process.env.DESKHAND_DESKTOP_IMAGE ?? "deskhand-desktop:dev";
const here = dirname(fileURLToPath(import.meta.url));
const SECCOMP = resolve(here, "../../../../images/desktop/chrome-seccomp.json");

export default async function setup(project: TestProject) {
  const ping = await docker("GET", "/_ping").catch((e: Error) => ({ status: 0, data: e.message }));
  if (ping.status !== 200) throw new Error(`Docker is not reachable (${JSON.stringify(ping.data)}). Run with DEV_DOCKER=1 scripts/dev ...`);
  const img = await docker("GET", `/images/${encodeURIComponent(IMAGE)}/json`);
  if (img.status !== 200) throw new Error(`Image ${IMAGE} not found. Build it: docker build -f images/desktop/Dockerfile -t deskhand-desktop:dev .`);

  const suffix = randomBytes(4).toString("hex");
  const netName = `deskhand-dev-e2e-${suffix}`;
  const key = randomBytes(24).toString("hex");
  const labels = { owner: "deskhand-dev", "deskhand-dev.purpose": "daemon-e2e" };
  await mustDocker("POST", "/networks/create", { Name: netName, Driver: "bridge", Labels: labels });

  const sandbox = process.env.DESKHAND_E2E_SANDBOX !== "0";
  const securityOpt = sandbox ? [`seccomp=${readFileSync(SECCOMP, "utf8")}`, "apparmor=unconfined"] : [];
  const created = await mustDocker<{ Id: string }>("POST", `/containers/create?name=deskhand-dev-e2e-${suffix}`, {
    Image: IMAGE,
    Labels: labels,
    Env: [
      `DESKHAND_DAEMON_KEY=${key}`,
      "DESKHAND_SCREEN=1280x800",
      "DESKHAND_LOCK_WAIT_MS=1500",
      "DESKHAND_STUCK_BUTTON_MS=2500",
      "TZ=Australia/Sydney",
    ],
    HostConfig: {
      NetworkMode: netName,
      ShmSize: 1024 * 1024 * 1024,
      SecurityOpt: securityOpt,
      Memory: 2 * 1024 * 1024 * 1024,
      NanoCpus: 2_000_000_000,
    },
  });
  const id = created.Id;
  const cleanup = async () => {
    await docker("DELETE", `/containers/${id}?force=1&v=1`).catch(() => undefined);
    await docker("DELETE", `/networks/${netName}`).catch(() => undefined);
  };
  try {
    await mustDocker("POST", `/containers/${id}/start`);
    const info = await mustDocker<{ NetworkSettings: { Networks: Record<string, { IPAddress: string }> } }>("GET", `/containers/${id}/json`);
    const ip = info.NetworkSettings.Networks[netName]!.IPAddress;
    const url = `http://${ip}:7000`;
    // Wait for the daemon and the X display.
    const t0 = Date.now();
    let ready = false;
    while (Date.now() - t0 < 60_000) {
      try {
        const r = await fetch(`${url}/state`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(2000) });
        if (r.ok) {
          const s = (await r.json()) as { screen: { width: number } };
          if (s.screen.width > 0) {
            // and a capture works
            const shot = await fetch(`${url}/screenshot?scale=0.1`, { headers: { authorization: `Bearer ${key}` } });
            if (shot.ok) {
              ready = true;
              break;
            }
          }
        }
      } catch {
        /* not yet */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!ready) throw new Error(`desktop did not become ready:\n${await containerLogs(id)}`);
    // Give openbox/tint2 a moment to finish mapping.
    await new Promise((r) => setTimeout(r, 1500));
    project.provide("daemonUrl", url);
    project.provide("daemonKey", key);
    project.provide("containerId", id);
  } catch (e) {
    await cleanup();
    throw e;
  }
  return async () => {
    if (process.env.DESKHAND_E2E_KEEP === "1") {
      console.log(`keeping container ${id} and network ${netName}`);
      return;
    }
    await cleanup();
  };
}
