/**
 * In-process runtime: every "container" is a FakeDaemon listening on 127.0.0.1.
 * Used by tests and for dashboard development without Docker (DESKHAND_RUNTIME=fake).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DeskhandError, LABELS } from "@deskhand/shared";
import { FakeDaemon } from "../fake-daemon/fake-daemon.js";
import type { ContainerInfo, ContainerStats, DesktopSpec, ExecOptions, ExecResult, HostInfo, ImageInfo, PathResolution, Runtime } from "./types.js";
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
  imageId: string;
}

export interface FakeRuntimeOptions {
  /** Inclusive port range for fake daemons. Default from DESKHAND_FAKE_PORTS or 17250-17299. */
  ports?: [number, number];
  lockWaitMs?: number;
  /** Host size the fake reports. Fixed defaults (32 GiB, 8 CPUs) keep tests independent of the machine. */
  memTotalBytes?: number;
  ncpu?: number;
  /** Daemon apiVersion to report (to test version_mismatch). */
  apiVersion?: number;
  /** Whether the fake "Docker host" has /dev/kvm (default: DESKHAND_FAKE_KVM, else false). */
  kvm?: boolean;
}

export class FakeRuntime implements Runtime {
  readonly kind = "fake" as const;
  readonly containers = new Map<string, FakeContainer>();
  readonly images = new Set<string>();
  /** Images that "fail to pull". */
  readonly unpullable = new Set<string>();
  dockerDown = false;
  diskFull = false;
  /** The fake Docker host has /dev/kvm (tests flip it). */
  kvm: boolean;
  /** Calls to kvmAvailable (tests check the result is cached). */
  kvmChecks = 0;
  private readonly ports: [number, number];
  private readonly root = fs.mkdtempSync(path.join(os.tmpdir(), "deskhand-fake-"));

  constructor(readonly opts: FakeRuntimeOptions = {}) {
    const env = process.env.DESKHAND_FAKE_PORTS?.split("-").map(Number);
    this.ports = opts.ports ?? (env && env.length === 2 ? [env[0]!, env[1]!] : [17250, 17299]);
    this.kvm = opts.kvm ?? ["1", "true", "on", "yes"].includes((process.env.DESKHAND_FAKE_KVM ?? "").toLowerCase());
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
    return { memTotalBytes: this.opts.memTotalBytes ?? 32 * 1024 ** 3, ncpu: this.opts.ncpu ?? 8 };
  }

  async kvmAvailable() {
    this.check();
    this.kvmChecks++;
    return this.kvm;
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
    const filesRoot = path.join(this.root, id);
    fs.mkdirSync(filesRoot, { recursive: true });
    const imageId = this.imageIds.get(spec.image) ?? `sha256:fake-${spec.image}`;
    this.containers.set(id, { id, spec, running: false, daemon: null, port: null, startedAt: null, finishedAt: null, filesRoot, imageId });
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

  /** copyDir calls (tests). */
  readonly dirCopies: Array<{ from: string; to: string; dir: string; exclude: string[] }> = [];

  async rename(id: string, name: string) {
    this.check();
    const c = this.containers.get(id);
    if (!c) throw new DeskhandError("internal", "no such container");
    if ([...this.containers.values()].some((o) => o !== c && o.spec.name === name)) throw new DeskhandError("internal", `name ${name} in use`);
    c.spec = { ...c.spec, name };
  }

  async copyDir(fromId: string, toId: string, dir: string, exclude: string[]) {
    this.check();
    const from = this.containers.get(fromId);
    const to = this.containers.get(toId);
    if (!from || !to) throw new DeskhandError("internal", "no such container");
    this.dirCopies.push({ from: fromId, to: toId, dir, exclude });
    const src = path.join(from.filesRoot, dir);
    if (!fs.existsSync(src)) return;
    fs.cpSync(src, path.join(to.filesRoot, dir), {
      recursive: true,
      filter: (p) => {
        const abs = path.posix.join(dir, path.relative(src, p).split(path.sep).join("/")).replace(/\/$/, "");
        return !exclude.some((x) => abs === x || abs.startsWith(`${x}/`));
      },
    });
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
      imageId: c.imageId,
      binds: c.spec.binds,
      memoryBytes: c.spec.memoryBytes,
      cpus: c.spec.cpus,
      kvm: !!c.spec.kvm,
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
    return { cpuPercent: 3.5, hostCpuPercent: 3.5 / (this.opts.ncpu ?? 8), memoryBytes: 150 * 1024 * 1024 };
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
    return true;
  }

  /** Image ids by name (tests change one to simulate a new base image). */
  readonly imageIds = new Map<string, string>();
  /** Calls to exec / writeFile / copyFromImage (tests). */
  readonly execCalls: Array<{ containerId: string; cmd: string[]; user?: string }> = [];
  readonly writes: Array<{ containerId: string; path: string; data: Buffer }> = [];
  readonly copies: Array<{ image: string; paths: string[]; containerId: string }> = [];
  /** Optional exec behaviour (tests): default exit 0 with no output. */
  execHandler: ((containerId: string, cmd: string[], opts: ExecOptions) => ExecResult | Promise<ExecResult>) | null = null;

  async imageInfo(image: string): Promise<ImageInfo | null> {
    this.check();
    if (!this.images.has(image)) return null;
    return { id: this.imageIds.get(image) ?? `sha256:fake-${image}`, created: "2026-10-22T00:00:00.000Z", labels: {} };
  }

  async exec(containerId: string, cmd: string[], opts: ExecOptions): Promise<ExecResult> {
    this.check();
    if (!this.containers.get(containerId)?.running) throw new DeskhandError("desktop_stopped");
    this.execCalls.push({ containerId, cmd, user: opts.user });
    if (cmd.some((c) => c.startsWith("# deskhand-manifest"))) {
      const m = this.containers.get(containerId)?.daemon?.behavior.manifest ?? { cookies: [], extensions: [], packages: [], baseList: true, notes: [] };
      return { exitCode: 0, stdout: JSON.stringify(m), stderr: "", timedOut: false };
    }
    return this.execHandler ? this.execHandler(containerId, cmd, opts) : { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  }

  async writeFile(containerId: string, filePath: string, data: Buffer) {
    this.check();
    this.writes.push({ containerId, path: filePath, data });
  }

  async copyFromImage(image: string, paths: string[], containerId: string, beforeEach?: (path: string) => Promise<void>) {
    this.check();
    if (!this.images.has(image)) throw new DeskhandError("internal", `no such image ${image}`);
    for (const p of paths) if (beforeEach) await beforeEach(p);
    this.copies.push({ image, paths, containerId });
    return paths;
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
