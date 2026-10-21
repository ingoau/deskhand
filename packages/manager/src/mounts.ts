/**
 * Mount policy (plan: "Mounts and security").
 * - Explicit mounts only, at the same path inside the desktop, read-only unless write.
 * - The Docker socket is always refused, including any path that resolves to it or contains it.
 * - Optional allow/deny lists, checked after resolving symlinks as the Docker host sees them
 *   (the manager may run in a container, so resolution goes through the runtime's helper).
 * - Host paths for file_put/file_get follow the same rules.
 */
import path from "node:path";
import { DeskhandError, type Mount } from "@deskhand/shared";
import type { PathResolution, Runtime } from "./runtime/types.js";

export interface PolicyConfig {
  mountAllow: string[];
  mountDeny: string[];
  dockerSocketPaths: string[];
}

export interface ResolvedMount {
  /** What the agent asked for (normalised); used as the path inside the desktop. */
  target: string;
  /** Fully resolved host path; used as the bind source so a later symlink swap cannot redirect it. */
  source: string;
  write: boolean;
}

/** Container paths a mount may never cover (exact path or any ancestor of it). */
const PROTECTED_EXACT = ["/tmp", "/var", "/home", "/home/agent", "/root", "/opt", "/srv", "/mnt", "/media"];
/** Container paths a mount may not be placed at or inside. */
const PROTECTED_TREES = ["/proc", "/sys", "/dev", "/run", "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/boot", "/var/run", "/var/lib", "/var/cache", "/tmp/.X11-unix", "/tmp/.ICE-unix"];

export function normalizeHostPath(p: string): string {
  if (typeof p !== "string" || !p.startsWith("/")) throw new DeskhandError("invalid_argument", `Host paths must be absolute (start with /): "${p}".`);
  if (p.includes("\0") || p.includes(":") || p.includes(",")) {
    throw new DeskhandError("invalid_argument", `Host paths may not contain ':' or ',' characters: "${p}".`);
  }
  const n = path.posix.normalize(p);
  return n.length > 1 ? n.replace(/\/+$/, "") : n;
}

/** a is b or inside b */
export function isWithin(a: string, b: string): boolean {
  if (b === "/") return true;
  return a === b || a.startsWith(b + "/");
}

function refuse(msg: string): never {
  throw new DeskhandError("mount_refused", msg);
}

export function checkTarget(target: string): void {
  for (const p of PROTECTED_TREES) {
    if (isWithin(target, p) || isWithin(p, target)) {
      refuse(`Mounting at ${target} would hide the desktop's own system files (${p}); mount a more specific directory instead.`);
    }
  }
  for (const p of PROTECTED_EXACT) {
    if (isWithin(p, target)) refuse(`Mounting at ${target} would hide the desktop's own ${p}; mount a more specific directory instead.`);
  }
}

export interface PolicyContext {
  allow: string[];
  deny: string[];
  sockets: string[];
}

/** Checks one resolved host path. `forMount` adds the container-target rules. */
export function evaluate(requested: string, res: PathResolution, ctx: PolicyContext, opts: { forMount: boolean; mustExist: boolean }): string {
  const src = res.resolved;
  if (res.error) refuse(`${requested} could not be resolved (${res.error}).`);
  // Docker socket: the path itself, anything resolving to it, and any directory containing it.
  for (const s of ctx.sockets) {
    const hit = opts.forMount ? isWithin(s, src) || isWithin(s, requested) : src === s || requested === s;
    if (hit) {
      refuse(`${requested} is or contains the Docker socket, which is never available inside a desktop; choose another path.`);
    }
  }
  if (res.type === "socket" && path.posix.basename(src) === "docker.sock") {
    refuse(`${requested} is a Docker socket, which is never available inside a desktop; choose another path.`);
  }
  for (const d of ctx.deny) {
    if (isWithin(src, d)) refuse(`${requested} is blocked by deskhand's mount rules (deny list); choose another path or ask the user.`);
    if (opts.forMount && isWithin(d, src)) refuse(`${requested} contains ${d}, which deskhand's mount rules block; choose a more specific path or ask the user.`);
  }
  if (ctx.allow.length > 0 && !ctx.allow.some((a) => isWithin(src, a))) {
    refuse(`${requested} is outside the directories deskhand allows (${ctx.allow.join(", ")}); choose a path inside one of them or ask the user.`);
  }
  if (opts.mustExist && !res.exists) {
    throw new DeskhandError("invalid_argument", `${requested} does not exist on the deskhand host.`);
  }
  if (opts.forMount) checkTarget(requested);
  return src;
}

export class MountPolicy {
  constructor(
    private readonly cfg: PolicyConfig,
    private readonly runtime: Runtime,
  ) {}

  private async context(extra: string[]): Promise<{ ctx: PolicyContext; resolved: PathResolution[] }> {
    const { mountAllow, mountDeny, dockerSocketPaths } = this.cfg;
    const all = [...extra, ...mountAllow, ...mountDeny, ...dockerSocketPaths];
    const res = await this.runtime.resolveHostPaths(all);
    const n = extra.length;
    const a = mountAllow.length;
    const d = mountDeny.length;
    const ctx: PolicyContext = {
      allow: res.slice(n, n + a).map((r) => r.resolved),
      deny: [...new Set([...mountDeny, ...res.slice(n + a, n + a + d).map((r) => r.resolved)])],
      sockets: [...new Set([...dockerSocketPaths, ...res.slice(n + a + d).map((r) => r.resolved)])],
    };
    return { ctx, resolved: res.slice(0, n) };
  }

  async checkMounts(mounts: Mount[]): Promise<ResolvedMount[]> {
    if (mounts.length === 0) return [];
    const targets = mounts.map((m) => normalizeHostPath(m.path));
    const seen = new Set<string>();
    for (const t of targets) {
      if (seen.has(t)) throw new DeskhandError("invalid_argument", `${t} is listed twice in mounts.`);
      seen.add(t);
      checkTarget(t);
    }
    const { ctx, resolved } = await this.context(targets);
    return mounts.map((m, i) => {
      const source = evaluate(targets[i]!, resolved[i]!, ctx, { forMount: true, mustExist: true });
      if (resolved[i]!.type !== "dir" && resolved[i]!.type !== "file") {
        throw new DeskhandError("mount_refused", `${targets[i]} is not a regular file or directory, so it cannot be mounted.`);
      }
      return { target: targets[i]!, source, write: !!m.write };
    });
  }

  /** For file_put: the host file to read. Returns the resolved path. */
  async checkReadFile(hostPath: string): Promise<string> {
    const p = normalizeHostPath(hostPath);
    const { ctx, resolved } = await this.context([p]);
    const src = evaluate(p, resolved[0]!, ctx, { forMount: false, mustExist: true });
    if (resolved[0]!.type === "dir") throw new DeskhandError("invalid_argument", `${p} is a directory; file_put copies single files.`);
    if (resolved[0]!.type !== "file") throw new DeskhandError("mount_refused", `${p} is not a regular file.`);
    return src;
  }

  /** For file_get: the host file to write (its directory must exist). Returns the resolved path. */
  async checkWriteFile(hostPath: string): Promise<string> {
    const p = normalizeHostPath(hostPath);
    if (p === "/") throw new DeskhandError("invalid_argument", "host_path must name a file.");
    const dir = path.posix.dirname(p);
    const { ctx, resolved } = await this.context([p, dir]);
    const fileRes = resolved[0]!;
    const dirRes = resolved[1]!;
    if (!dirRes.exists || dirRes.type !== "dir") throw new DeskhandError("invalid_argument", `The directory ${dir} does not exist on the deskhand host.`);
    if (fileRes.exists && fileRes.type !== "file") throw new DeskhandError("mount_refused", `${p} exists and is not a regular file.`);
    // Check both the file (if it is a symlink it resolves elsewhere) and its directory.
    evaluate(dir, dirRes, ctx, { forMount: false, mustExist: true });
    return evaluate(p, fileRes, ctx, { forMount: false, mustExist: false });
  }
}
