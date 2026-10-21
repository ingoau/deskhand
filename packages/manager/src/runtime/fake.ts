/**
 * In-process runtime: every "container" is a FakeDaemon listening on 127.0.0.1.
 * Used by tests and for dashboard development without Docker (DESKHAND_RUNTIME=fake).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DeskhandError, LABELS } from "@deskhand/shared";
import { FakeDaemon } from "../fake-daemon/fake-daemon.js";
import type { ContainerInfo, ContainerStats, DesktopSpec, HostInfo, PathResolution, Runtime } from "./types.js";
import { randomId } from "../util.js";

interface FakeContainer {
  id: string;
  spec: DesktopSpec;
  running: boolean;
  daemon: FakeDaemon | null;
  port: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  filesRoot: string;
}

export interface FakeRuntimeOptions {
  /** Inclusive port range for fake daemons. Default from DESKHAND_FAKE_PORTS or 17250-17299. */
  ports?: [number, number];
  lockWaitMs?: number;
  memTotalBytes?: number;
  /** Daemon apiVersion to report (to test version_mismatch). */
  apiVersion?: number;
}

export class FakeRuntime implements Runtime {
  readonly kind = "fake" as const;
  readonly containers = new Map<string, FakeContainer>();
  readonly images = new Set<string>();
  /** Images that "fail to pull". */
  readonly unpullable = new Set<string>();
  dockerDown = false;
  diskFull = false;
  private readonly ports: [number, number];
  private readonly root = fs.mkdtempSync(path.join(os.tmpdir(), "deskhand-fake-"));

  constructor(readonly opts: FakeRuntimeOptions = {}) {
    const env = process.env.DESKHAND_FAKE_PORTS?.split("-").map(Number);
    this.ports = opts.ports ?? (env && env.length === 2 ? [env[0]!, env[1]!] : [17250, 17299]);
  }

  private check() {
    if (this.dockerDown) throw new DeskhandError("docker_unavailable");
  }

  daemonFor(containerOrDesktopId: string): FakeDaemon | null {
    for (const c of this.containers.values()) {
      if (c.id === containerOrDesktopId || c.spec.id === containerOrDesktopId) return c.daemon;
    }
    return null;
  }

  async ping() {
    this.check();
  }

  async hostInfo(): Promise<HostInfo> {
    this.check();
    return { memTotalBytes: this.opts.memTotalBytes ?? os.totalmem(), ncpu: os.cpus().length };
  }

  async ensureNetwork() {
    this.check();
  }

  async imageExists(image: string) {
    this.check();
    return this.images.has(image);
  }

  async ensureImage(image: string) {
    this.check();
    if (this.images.has(image)) return;
    if (this.unpullable.has(image)) throw new DeskhandError("image_pull_failed");
    this.images.add(image);
  }

  async createDesktop(spec: DesktopSpec): Promise<string> {
    this.check();
    if (this.diskFull) throw new DeskhandError("disk_full");
    if ([...this.containers.values()].some((c) => c.spec.name === spec.name)) throw new DeskhandError("internal", `name ${spec.name} in use`);
    const id = randomId(16);
    const filesRoot = path.join(this.root, spec.id);
    fs.mkdirSync(filesRoot, { recursive: true });
    this.containers.set(id, { id, spec, running: false, daemon: null, port: null, startedAt: null, finishedAt: null, filesRoot });
    return id;
  }

  private async listenInRange(make: (port: number) => FakeDaemon): Promise<{ daemon: FakeDaemon; port: number }> {
    const [lo, hi] = this.ports;
    const span = hi - lo + 1;
    const startAt = Math.floor(Math.random() * span);
    for (let i = 0; i < span; i++) {
      const port = lo + ((startAt + i) % span);
      const d = make(port);
      try {
        await d.listen();
        return { daemon: d, port };
      } catch (e) {
        if ((e as { code?: string }).code !== "EADDRINUSE") throw e;
      }
    }
    throw new DeskhandError("internal", "no free port for a fake daemon");
  }

  async start(id: string) {
    this.check();
    const c = this.containers.get(id);
    if (!c) throw new DeskhandError("internal", "no such container");
    if (c.running) return;
    const [w, h] = (c.spec.env.DESKHAND_SCREEN ?? "1280x800").split("x").map(Number);
    const { daemon, port } = await this.listenInRange(
      (p) =>
        new FakeDaemon({
          key: c.spec.env.DESKHAND_DAEMON_KEY ?? "",
          port: p,
          host: "127.0.0.1",
          width: w,
          height: h,
          filesRoot: c.filesRoot,
          lockWaitMs: this.opts.lockWaitMs ?? (process.env.DESKHAND_FAKE_LOCK_WAIT_MS ? Number(process.env.DESKHAND_FAKE_LOCK_WAIT_MS) : undefined),
          apiVersion: this.opts.apiVersion,
        }),
    );
    c.daemon = daemon;
    c.port = port;
    c.running = true;
    c.startedAt = new Date().toISOString();
  }

  async stop(id: string) {
    this.check();
    const c = this.containers.get(id);
    if (!c || !c.running) return;
    await c.daemon?.close();
    c.daemon = null;
    c.port = null;
    c.running = false;
    c.finishedAt = new Date().toISOString();
  }

  /** Simulates a container dying on its own (crash, host reboot). */
  async crash(id: string) {
    await this.stop(id);
  }

  async restart(id: string) {
    await this.stop(id);
    await this.start(id);
  }

  async remove(id: string) {
    this.check();
    const c = this.containers.get(id);
    if (!c) return;
    await this.stop(id);
    this.containers.delete(id);
    fs.rmSync(c.filesRoot, { recursive: true, force: true });
  }

  private info(c: FakeContainer): ContainerInfo {
    return {
      containerId: c.id,
      name: c.spec.name,
      running: c.running,
      state: c.running ? "running" : c.startedAt ? "exited" : "created",
      labels: { ...c.spec.labels, [LABELS.kind]: "desktop" },
      env: c.spec.env,
      daemonUrl: c.running ? `http://127.0.0.1:${c.port}` : null,
      startedAt: c.startedAt,
      finishedAt: c.finishedAt,
      image: c.spec.image,
      binds: c.spec.binds,
    };
  }

  async inspect(id: string) {
    this.check();
    const c = this.containers.get(id);
    return c ? this.info(c) : null;
  }

  async listDesktops() {
    this.check();
    return [...this.containers.values()].map((c) => this.info(c));
  }

  async stats(id: string): Promise<ContainerStats | null> {
    const c = this.containers.get(id);
    if (!c?.running) return null;
    return { cpuPercent: 3.5, hostCpuPercent: 3.5 / os.cpus().length, memoryBytes: 150 * 1024 * 1024 };
  }

  async diskUsage() {
    const m = new Map<string, number>();
    for (const c of this.containers.values()) m.set(c.id, 4096);
    return m;
  }

  async commit(id: string, opts: { repo: string; tag: string }) {
    this.check();
    if (!this.containers.has(id)) throw new DeskhandError("internal", "no such container");
    const image = `${opts.repo}:${opts.tag}`;
    this.images.add(image);
    return { image, sizeBytes: 1024 * 1024 };
  }

  async removeImage(image: string) {
    this.images.delete(image);
  }

  async resolveHostPaths(paths: string[]): Promise<PathResolution[]> {
    return Promise.all(
      paths.map(async (input) => {
        try {
          const resolved = await fs.promises.realpath(input);
          const st = await fs.promises.stat(resolved);
          const type = st.isSocket() ? "socket" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
          return { input, resolved, exists: true, type } as PathResolution;
        } catch {
          // Resolve the existing prefix, append the rest lexically.
          let dir = path.dirname(input);
          const rest = [path.basename(input)];
          for (;;) {
            try {
              const r = await fs.promises.realpath(dir);
              return { input, resolved: path.join(r, ...rest), exists: false, type: "missing" } as PathResolution;
            } catch {
              if (dir === "/") return { input, resolved: input, exists: false, type: "missing" } as PathResolution;
              rest.unshift(path.basename(dir));
              dir = path.dirname(dir);
            }
          }
        }
      }),
    );
  }

  async readHostFile(p: string, maxBytes: number) {
    const st = await fs.promises.stat(p).catch(() => null);
    if (!st) throw new DeskhandError("not_found", `No such file on the deskhand host: ${p}`);
    if (st.isDirectory()) throw new DeskhandError("invalid_argument", `${p} is a directory; file_put copies single files.`);
    if (st.size > maxBytes) throw new DeskhandError("invalid_argument", `That file is larger than the ${maxBytes}-byte limit.`);
    return fs.promises.readFile(p);
  }

  async writeHostFile(p: string, data: Buffer) {
    await fs.promises.writeFile(p, data);
  }

  /** Like Docker, desktops outlive the manager: closing the runtime leaves them running (see destroy). */
  async close() {}

  /** Removes everything (tests). */
  async destroy() {
    for (const c of this.containers.values()) await c.daemon?.close();
    for (const id of [...this.containers.keys()]) await this.remove(id);
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}
