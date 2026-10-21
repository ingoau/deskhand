import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, type Readable } from "node:stream";
import Docker from "dockerode";
import tar from "tar-stream";
import type { Logger } from "pino";
import { DAEMON_PORT, DeskhandError, LABELS } from "@deskhand/shared";
import type { Config } from "../config.js";
import type { ContainerInfo, ContainerStats, DesktopSpec, ExecOptions, ExecResult, HostInfo, ImageInfo, PathResolution, Runtime } from "./types.js";

/** Maps dockerode/engine errors onto deskhand error codes. */
export function mapDockerError(e: unknown, fallback: "internal" | "image_pull_failed" = "internal"): DeskhandError {
  if (e instanceof DeskhandError) return e;
  const err = e as { code?: string; statusCode?: number; message?: string; json?: { message?: string } };
  const msg = String(err?.json?.message ?? err?.message ?? e);
  if (["ECONNREFUSED", "ENOENT", "EACCES", "EPERM", "ECONNRESET", "EPIPE"].includes(err?.code ?? "") && !err.statusCode) {
    return new DeskhandError("docker_unavailable", undefined, { cause: err.code });
  }
  if (/no space left on device/i.test(msg)) return new DeskhandError("disk_full", undefined, { cause: msg });
  if (fallback === "image_pull_failed") return new DeskhandError("image_pull_failed", undefined, { cause: msg });
  return new DeskhandError("internal", undefined, { cause: msg.slice(0, 500) });
}

const RESOLVE_SCRIPT = `
resolve() {
  p="$1"; out=""; n=0
  while [ -n "$p" ]; do
    while [ "\${p#/}" != "$p" ]; do p="\${p#/}"; done
    [ -z "$p" ] && break
    comp="\${p%%/*}"
    if [ "$comp" = "$p" ]; then p=""; else p="\${p#*/}"; fi
    case "$comp" in
      .) continue;;
      ..) out="\${out%/*}"; continue;;
    esac
    cand="$out/$comp"
    if [ -L "/host$cand" ]; then
      n=$((n+1)); if [ $n -gt 40 ]; then printf 'loop\\t%s\\n' "$1"; return; fi
      t="$(readlink "/host$cand")"
      case "$t" in /*) out="";; esac
      if [ -n "$p" ]; then p="$t/$p"; else p="$t"; fi
    else
      out="$cand"
    fi
  done
  r="\${out:-/}"
  if [ -S "/host$r" ]; then ty=socket; elif [ -d "/host$r" ]; then ty=dir; elif [ -f "/host$r" ]; then ty=file; elif [ -e "/host$r" ]; then ty=other; else ty=missing; fi
  printf '%s\\t%s\\n' "$ty" "$r"
}
for a in "$@"; do resolve "$a"; done
`;

/** Splits Docker's multiplexed stdout/stderr log stream. */
function demux(buf: Buffer): { stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  let off = 0;
  while (off + 8 <= buf.length) {
    const type = buf[off];
    const len = buf.readUInt32BE(off + 4);
    const payload = buf.subarray(off + 8, off + 8 + len).toString("utf8");
    if (type === 2) stderr += payload;
    else stdout += payload;
    off += 8 + len;
  }
  return { stdout, stderr };
}

function envObject(env: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of env ?? []) {
    const i = kv.indexOf("=");
    if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}

export class DockerRuntime implements Runtime {
  readonly kind = "docker" as const;
  readonly docker: Docker;
  private networkReady = false;

  constructor(
    private readonly cfg: Config,
    private readonly log: Logger,
    docker?: Docker,
  ) {
    this.docker = docker ?? new Docker();
  }

  private ownerFilters(kind: string): string[] {
    const f = [`${LABELS.owner}=${this.cfg.ownerLabel}`, `${LABELS.kind}=${kind}`];
    if (this.cfg.instance) f.push(`${LABELS.instance}=${this.cfg.instance}`);
    return f;
  }

  private baseLabels(kind: string): Record<string, string> {
    const l: Record<string, string> = { [LABELS.owner]: this.cfg.ownerLabel, [LABELS.kind]: kind };
    if (this.cfg.instance) l[LABELS.instance] = this.cfg.instance;
    return l;
  }

  async ping(): Promise<void> {
    try {
      await this.docker.ping();
    } catch (e) {
      throw new DeskhandError("docker_unavailable", undefined, { cause: (e as Error)?.message });
    }
  }

  async hostInfo(): Promise<HostInfo> {
    try {
      const info = (await this.docker.info()) as { MemTotal?: number; NCPU?: number };
      return { memTotalBytes: info.MemTotal ?? os.totalmem(), ncpu: info.NCPU ?? os.cpus().length };
    } catch (e) {
      throw mapDockerError(e);
    }
  }

  /**
   * Looks for /dev/kvm on the Docker host (the manager may run in a container that cannot see the
   * host's /dev): a short-lived helper with the host's /dev mounted read-only checks for the
   * character device. The caller caches the answer.
   */
  async kvmAvailable(): Promise<boolean> {
    const r = await this.runHelper(["sh", "-c", "if [ -c /hostdev/kvm ]; then echo yes; else echo no; fi"], ["/dev:/hostdev:ro"]);
    if (r.exitCode !== 0) throw new DeskhandError("internal", "deskhand could not check the Docker host for /dev/kvm.", { stderr: r.stderr.slice(0, 300) });
    return r.stdout.trim() === "yes";
  }

  async ensureNetwork(): Promise<void> {
    if (this.networkReady) return;
    try {
      const nets = await this.docker.listNetworks({ filters: { name: [this.cfg.network] } });
      if (!nets.some((n) => n.Name === this.cfg.network)) {
        try {
          await this.docker.createNetwork({ Name: this.cfg.network, Driver: "bridge", Labels: this.baseLabels("network"), CheckDuplicate: true } as Docker.NetworkCreateOptions);
          this.log.info({ network: this.cfg.network }, "created desktop network");
        } catch (e) {
          if ((e as { statusCode?: number }).statusCode !== 409) throw e;
        }
      }
      await this.attachSelf();
      this.networkReady = true;
    } catch (e) {
      throw mapDockerError(e);
    }
  }

  /** When the manager runs in a container, join the desktop network so daemons are reachable by IP. */
  private async attachSelf(): Promise<void> {
    if (!fs.existsSync("/.dockerenv")) return;
    try {
      const self = await this.docker.getContainer(os.hostname()).inspect();
      if (self.HostConfig?.NetworkMode === "host") return;
      if (self.NetworkSettings?.Networks?.[this.cfg.network]) return;
      await this.docker.getNetwork(this.cfg.network).connect({ Container: self.Id });
      this.log.info({ network: this.cfg.network }, "attached manager container to desktop network");
    } catch (e) {
      this.log.debug({ err: (e as Error)?.message }, "could not self-attach to desktop network (not fatal)");
    }
  }

  async imageExists(image: string): Promise<boolean> {
    try {
      await this.docker.getImage(image).inspect();
      return true;
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return false;
      throw mapDockerError(e);
    }
  }

  async ensureImage(image: string): Promise<void> {
    if (await this.imageExists(image)) return;
    this.log.info({ image }, "pulling image");
    try {
      const stream = (await this.docker.pull(image)) as Readable;
      await new Promise<void>((resolve, reject) => {
        this.docker.modem.followProgress(stream, (err: Error | null, out: Array<{ error?: string }>) => {
          const failed = out?.find((o) => o.error);
          if (err || failed) reject(err ?? new Error(failed!.error));
          else resolve();
        });
      });
    } catch (e) {
      throw mapDockerError(e, "image_pull_failed");
    }
    if (!(await this.imageExists(image))) throw new DeskhandError("image_pull_failed");
  }

  async createDesktop(spec: DesktopSpec): Promise<string> {
    await this.ensureNetwork();
    try {
      const c = await this.docker.createContainer({
        name: spec.name,
        Image: spec.image,
        Hostname: spec.name,
        Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
        Labels: { ...spec.labels, ...this.baseLabels("desktop") },
        HostConfig: {
          NetworkMode: this.cfg.network,
          Memory: spec.memoryBytes,
          NanoCpus: Math.round(spec.cpus * 1e9),
          ShmSize: 1024 ** 3,
          ...(spec.kvm ? { Devices: [{ PathOnHost: "/dev/kvm", PathInContainer: "/dev/kvm", CgroupPermissions: "rwm" }] } : {}),
          Binds: spec.binds.map((b) => `${b.source}:${b.target}:${b.write ? "rw" : "ro"}`),
          RestartPolicy: { Name: "no" },
        },
      });
      return c.id;
    } catch (e) {
      throw mapDockerError(e);
    }
  }

  async start(id: string): Promise<void> {
    try {
      await this.docker.getContainer(id).start();
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 304) return;
      throw mapDockerError(e);
    }
  }

  async stop(id: string, timeoutSec = 10): Promise<void> {
    try {
      await this.docker.getContainer(id).stop({ t: timeoutSec });
    } catch (e) {
      const s = (e as { statusCode?: number }).statusCode;
      if (s === 304 || s === 404) return;
      throw mapDockerError(e);
    }
  }

  async restart(id: string): Promise<void> {
    try {
      await this.docker.getContainer(id).restart({ t: 10 });
    } catch (e) {
      throw mapDockerError(e);
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await this.docker.getContainer(id).remove({ force: true, v: true });
    } catch (e) {
      const s = (e as { statusCode?: number }).statusCode;
      if (s === 404 || s === 409) return; // gone, or removal already in progress
      throw mapDockerError(e);
    }
  }

  async inspect(id: string): Promise<ContainerInfo | null> {
    try {
      const c = await this.docker.getContainer(id).inspect();
      return this.toInfo(c);
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return null;
      throw mapDockerError(e);
    }
  }

  private toInfo(c: Docker.ContainerInspectInfo): ContainerInfo {
    const ip = c.NetworkSettings?.Networks?.[this.cfg.network]?.IPAddress;
    const binds = (c.HostConfig?.Binds ?? []).map((b) => {
      const [source, target, mode] = b.split(":");
      return { source: source!, target: target ?? source!, write: mode === "rw" };
    });
    return {
      containerId: c.Id,
      name: c.Name.replace(/^\//, ""),
      running: !!c.State?.Running,
      state: c.State?.Status ?? "unknown",
      labels: c.Config?.Labels ?? {},
      env: envObject(c.Config?.Env),
      daemonUrl: c.State?.Running && ip ? `http://${ip}:${DAEMON_PORT}` : null,
      startedAt: c.State?.StartedAt && !c.State.StartedAt.startsWith("0001") ? c.State.StartedAt : null,
      finishedAt: c.State?.FinishedAt && !c.State.FinishedAt.startsWith("0001") ? c.State.FinishedAt : null,
      image: c.Config?.Image ?? "",
      binds,
      memoryBytes: c.HostConfig?.Memory || undefined,
      cpus: c.HostConfig?.NanoCpus ? c.HostConfig.NanoCpus / 1e9 : undefined,
      kvm: ((c.HostConfig?.Devices ?? []) as Array<{ PathInContainer?: string }>).some((d) => d.PathInContainer === "/dev/kvm"),
    };
  }

  async listDesktops(): Promise<ContainerInfo[]> {
    try {
      const list = await this.docker.listContainers({ all: true, filters: { label: this.ownerFilters("desktop") } });
      const out: ContainerInfo[] = [];
      for (const c of list) {
        const info = await this.inspect(c.Id);
        if (info) out.push(info);
      }
      return out;
    } catch (e) {
      throw mapDockerError(e);
    }
  }

  async stats(id: string): Promise<ContainerStats | null> {
    try {
      const s = (await this.docker.getContainer(id).stats({ stream: false })) as unknown as {
        cpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number; online_cpus?: number };
        precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
        memory_stats?: { usage?: number; stats?: Record<string, number> };
      };
      const cpuDelta = (s.cpu_stats?.cpu_usage?.total_usage ?? 0) - (s.precpu_stats?.cpu_usage?.total_usage ?? 0);
      const sysDelta = (s.cpu_stats?.system_cpu_usage ?? 0) - (s.precpu_stats?.system_cpu_usage ?? 0);
      const online = s.cpu_stats?.online_cpus ?? os.cpus().length;
      const hostCpuPercent = sysDelta > 0 && cpuDelta >= 0 ? (cpuDelta / sysDelta) * 100 : 0;
      const usage = s.memory_stats?.usage ?? 0;
      const cache = s.memory_stats?.stats?.inactive_file ?? s.memory_stats?.stats?.total_inactive_file ?? s.memory_stats?.stats?.cache ?? 0;
      return { cpuPercent: hostCpuPercent * online, hostCpuPercent, memoryBytes: Math.max(0, usage - cache) };
    } catch {
      return null;
    }
  }

  async diskUsage(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    try {
      const list = await this.docker.listContainers({ all: true, size: true, filters: { label: this.ownerFilters("desktop") } });
      for (const c of list) out.set(c.Id, (c as { SizeRw?: number }).SizeRw ?? 0);
    } catch {
      /* best effort */
    }
    return out;
  }

  async commit(id: string, opts: { repo: string; tag: string; labels: Record<string, string>; env: string[] }) {
    try {
      const changes = Object.entries({ ...opts.labels, ...this.baseLabels("template") }).map(([k, v]) => `LABEL ${JSON.stringify(k)}=${JSON.stringify(v)}`);
      await this.docker.getContainer(id).commit({
        _query: { container: id, repo: opts.repo, tag: opts.tag, pause: true, changes },
        _body: { Env: opts.env },
      } as unknown as Record<string, unknown>);
      const image = `${opts.repo}:${opts.tag}`;
      const info = await this.docker.getImage(image).inspect();
      return { image, sizeBytes: info.Size ?? null };
    } catch (e) {
      throw mapDockerError(e);
    }
  }

  async removeImage(image: string): Promise<boolean> {
    try {
      await this.docker.getImage(image).remove();
      return true;
    } catch (e) {
      const s = (e as { statusCode?: number }).statusCode;
      if (s === 404) return true;
      if (s === 409) return false; // a container still uses it
      throw mapDockerError(e);
    }
  }

  async imageInfo(image: string): Promise<ImageInfo | null> {
    try {
      const i = await this.docker.getImage(image).inspect();
      return { id: i.Id, created: new Date(i.Created).toISOString(), labels: i.Config?.Labels ?? {} };
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return null;
      throw mapDockerError(e);
    }
  }

  async exec(id: string, cmd: string[], opts: ExecOptions): Promise<ExecResult> {
    // The time limit is enforced inside the container (coreutils timeout), so nothing keeps running after we give up.
    const secs = Math.max(1, Math.ceil(opts.timeoutMs / 1000));
    const wrapped = ["timeout", "--signal=TERM", "--kill-after=10", String(secs), ...cmd];
    try {
      const ex = await this.docker.getContainer(id).exec({
        Cmd: wrapped,
        User: opts.user ?? "root",
        Env: opts.env,
        WorkingDir: opts.workdir,
        AttachStdout: true,
        AttachStderr: true,
        AttachStdin: false,
        Tty: false,
      });
      const stream = (await ex.start({ hijack: true, stdin: false })) as unknown as NodeJS.ReadableStream;
      const out = new PassThrough();
      const err = new PassThrough();
      const cap = 1024 * 1024;
      let stdout = "";
      let stderr = "";
      out.on("data", (d: Buffer) => {
        if (stdout.length < cap) stdout += d.toString("utf8");
      });
      err.on("data", (d: Buffer) => {
        if (stderr.length < cap) stderr += d.toString("utf8");
      });
      this.docker.modem.demuxStream(stream, out, err);
      await new Promise<void>((resolve, reject) => {
        const guard = setTimeout(() => resolve(), opts.timeoutMs + 20_000);
        stream.on("end", () => (clearTimeout(guard), resolve()));
        stream.on("close", () => (clearTimeout(guard), resolve()));
        stream.on("error", (e) => (clearTimeout(guard), reject(e)));
      });
      const info = await ex.inspect();
      const exitCode = info.Running ? null : (info.ExitCode ?? null);
      return { exitCode, stdout, stderr, timedOut: exitCode === 124 || exitCode === 137 || info.Running };
    } catch (e) {
      throw mapDockerError(e);
    }
  }

  async writeFile(id: string, filePath: string, data: Buffer, opts: { uid: number; gid: number; mode: number }): Promise<void> {
    const pack = tar.pack();
    pack.entry({ name: path.posix.basename(filePath), size: data.length, mode: opts.mode, uid: opts.uid, gid: opts.gid, mtime: new Date() }, data);
    pack.finalize();
    const body = new PassThrough();
    pack.pipe(body);
    try {
      await this.docker.getContainer(id).putArchive(body, { path: path.posix.dirname(filePath) });
    } catch (e) {
      throw mapDockerError(e);
    }
  }

  async copyFromImage(image: string, paths: string[], id: string, beforeEach?: (path: string) => Promise<void>): Promise<string[]> {
    let src: Docker.Container | undefined;
    const copied: string[] = [];
    try {
      src = await this.docker.createContainer({
        Image: image,
        Entrypoint: ["/bin/true"],
        Cmd: [],
        Labels: this.baseLabels("helper"),
        HostConfig: { NetworkMode: "none" },
      });
      const dst = this.docker.getContainer(id);
      for (const p of paths) {
        let stream: NodeJS.ReadableStream;
        try {
          stream = await src.getArchive({ path: p });
        } catch (e) {
          if ((e as { statusCode?: number }).statusCode === 404) continue;
          throw e;
        }
        if (beforeEach) await beforeEach(p);
        await dst.putArchive(stream as unknown as Readable, { path: path.posix.dirname(p) });
        copied.push(p);
      }
      return copied;
    } catch (e) {
      throw mapDockerError(e);
    } finally {
      if (src) await src.remove({ force: true }).catch(() => undefined);
    }
  }

  /** Runs a short-lived helper container and returns its output. */
  private async runHelper(cmd: string[], binds: string[], timeoutMs = 30_000): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    await this.ensureImage(this.cfg.helperImage);
    let c: Docker.Container | undefined;
    try {
      c = await this.docker.createContainer({
        Image: this.cfg.helperImage,
        Cmd: cmd,
        Labels: this.baseLabels("helper"),
        HostConfig: { Binds: binds, NetworkMode: "none", AutoRemove: false },
      });
      await c.start();
      const res = (await Promise.race([
        c.wait(),
        new Promise((_, rej) => setTimeout(() => rej(new DeskhandError("timeout", "The deskhand path helper did not finish in time.")), timeoutMs)),
      ])) as { StatusCode: number };
      const logs = (await c.logs({ stdout: true, stderr: true, follow: false })) as unknown as Buffer;
      return { exitCode: res.StatusCode, ...demux(Buffer.isBuffer(logs) ? logs : Buffer.from(logs)) };
    } catch (e) {
      throw mapDockerError(e);
    } finally {
      if (c) await c.remove({ force: true }).catch(() => undefined);
    }
  }

  async resolveHostPaths(paths: string[]): Promise<PathResolution[]> {
    if (paths.length === 0) return [];
    const { stdout, exitCode, stderr } = await this.runHelper(["sh", "-c", RESOLVE_SCRIPT, "resolve", ...paths], ["/:/host:ro"]);
    if (exitCode !== 0) throw new DeskhandError("internal", "deskhand could not check that host path.", { stderr: stderr.slice(0, 300) });
    const lines = stdout.split("\n").filter(Boolean);
    return paths.map((input, i) => {
      const [type, resolved] = (lines[i] ?? "missing\t" + input).split("\t") as [string, string];
      if (type === "loop") return { input, resolved: input, exists: false, type: "missing", error: "too many levels of symbolic links" };
      const t = (["dir", "file", "socket", "other", "missing"].includes(type) ? type : "missing") as PathResolution["type"];
      return { input, resolved, exists: t !== "missing", type: t };
    });
  }

  /** Creates (never starts) a container with the directory bind-mounted, then uses the archive API. */
  private async withDirContainer<T>(dir: string, write: boolean, fn: (c: Docker.Container) => Promise<T>): Promise<T> {
    await this.ensureImage(this.cfg.helperImage);
    const c = await this.docker
      .createContainer({
        Image: this.cfg.helperImage,
        Cmd: ["true"],
        Labels: this.baseLabels("helper"),
        HostConfig: { Binds: [`${dir}:/x:${write ? "rw" : "ro"}`], NetworkMode: "none" },
      })
      .catch((e) => {
        throw mapDockerError(e);
      });
    try {
      return await fn(c);
    } finally {
      await c.remove({ force: true }).catch(() => undefined);
    }
  }

  async readHostFile(resolvedPath: string, maxBytes: number): Promise<Buffer> {
    return this.withDirContainer(path.posix.dirname(resolvedPath), false, async (c) => {
      let stream: NodeJS.ReadableStream;
      try {
        stream = await c.getArchive({ path: `/x/${path.posix.basename(resolvedPath)}` });
      } catch (e) {
        if ((e as { statusCode?: number }).statusCode === 404) throw new DeskhandError("not_found", `No such file on the deskhand host: ${resolvedPath}`);
        throw mapDockerError(e);
      }
      return new Promise<Buffer>((resolve, reject) => {
        const extract = tar.extract();
        let result: Buffer | undefined;
        extract.on("entry", (header, entry, next) => {
          if (result !== undefined || header.type !== "file") {
            entry.resume();
            entry.on("end", next);
            if (result === undefined && header.type === "directory") {
              reject(new DeskhandError("invalid_argument", `${resolvedPath} is a directory; file_put copies single files.`));
            }
            return;
          }
          if ((header.size ?? 0) > maxBytes) {
            reject(new DeskhandError("invalid_argument", `That file is larger than the ${maxBytes}-byte limit.`));
            entry.resume();
            entry.on("end", next);
            return;
          }
          const parts: Buffer[] = [];
          entry.on("data", (d: unknown) => parts.push(d as Buffer));
          entry.on("end", () => {
            result = Buffer.concat(parts);
            next();
          });
        });
        extract.on("finish", () => (result ? resolve(result) : reject(new DeskhandError("not_found", `No such file on the deskhand host: ${resolvedPath}`))));
        extract.on("error", reject);
        (stream as Readable).pipe(extract);
      });
    });
  }

  async writeHostFile(resolvedPath: string, data: Buffer, uid: number, gid: number): Promise<void> {
    await this.withDirContainer(path.posix.dirname(resolvedPath), true, async (c) => {
      const pack = tar.pack();
      pack.entry({ name: path.posix.basename(resolvedPath), size: data.length, mode: 0o644, uid, gid, mtime: new Date() }, data);
      pack.finalize();
      const body = new PassThrough();
      pack.pipe(body);
      try {
        await c.putArchive(body, { path: "/x" });
      } catch (e) {
        throw mapDockerError(e);
      }
    });
  }

  async close(): Promise<void> {
    /* nothing pooled */
  }
}
