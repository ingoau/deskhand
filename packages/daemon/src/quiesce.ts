/**
 * POST /quiesce — prepare the desktop for `docker commit`: close Chromium through CDP (cookies are
 * flushed), close other apps' windows, then clear caches, ~/Downloads and /tmp. Paths that are (or
 * contain) mount points are never touched, so host directories mounted into the desktop survive.
 */
import { readdirSync, readFileSync, rmSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { closeBrowserViaCdp } from "./cdp.js";
import { runExec } from "./exec.js";
import { log } from "./log.js";
import { listProcs } from "./procs.js";
import { agentUser } from "./session.js";
import { sleep } from "./util.js";

/** Processes that make up the desktop itself and must keep running. */
const CORE = new Set(["Xvfb", "openbox", "tint2", "x11vnc", "dbus-daemon", "at-spi-bus-laun", "at-spi2-registr", "supervisord", "node", "bash", "sh"]);
/** Never delete these from /tmp (X and ICE sockets). */
const TMP_KEEP = new Set([".X11-unix", ".ICE-unix", ".X0-lock", ".font-unix", ".XIM-unix", ".Test-unix"]);

export function mountPoints(): string[] {
  try {
    return readFileSync("/proc/self/mountinfo", "utf8")
      .split("\n")
      .map((l) => l.split(" ")[4])
      .filter((p): p is string => !!p)
      .map((p) => p.replace(/\\040/g, " "));
  } catch {
    return [];
  }
}

/** True if `path` is a mount point or has one beneath it. */
export function touchesMount(path: string, mounts: string[]): boolean {
  const p = path.replace(/\/+$/, "");
  return mounts.some((m) => m === p || m.startsWith(p + "/"));
}

/** Delete the contents of `dir` (not the dir itself), skipping mounts and `keep` names. */
export function clearDir(dir: string, mounts: string[], keep: Set<string> = new Set()): { removed: number; skipped: string[] } {
  const skipped: string[] = [];
  let removed = 0;
  let entries: string[] = [];
  try {
    if (touchesMount(dir, mounts) && mounts.includes(dir.replace(/\/+$/, ""))) {
      return { removed, skipped: [dir] };
    }
    entries = readdirSync(dir);
  } catch {
    return { removed, skipped };
  }
  for (const name of entries) {
    if (keep.has(name)) continue;
    const p = join(dir, name);
    if (touchesMount(p, mounts)) {
      skipped.push(p);
      continue;
    }
    try {
      lstatSync(p);
      rmSync(p, { recursive: true, force: true });
      removed++;
    } catch (e) {
      skipped.push(`${p} (${(e as Error).message})`);
    }
  }
  return { removed, skipped };
}

export interface QuiesceResult {
  ok: true;
  chromiumClosed: boolean;
  closedWindows: number;
  killed: string[];
  cleared: string[];
  notes: string[];
}

export async function quiesce(): Promise<QuiesceResult> {
  const notes: string[] = [];
  const user = agentUser();

  // 1. Chromium: Browser.close over CDP flushes cookies and the session to disk.
  let chromiumClosed = false;
  try {
    chromiumClosed = await closeBrowserViaCdp();
  } catch (e) {
    notes.push(`Chromium could not be closed through CDP: ${(e as Error).message}`);
  }

  // 2. Other apps: ask every window to close (WM_DELETE_WINDOW), then terminate leftovers.
  let closedWindows = 0;
  const list = await runExec({ command: "wmctrl -l 2>/dev/null | awk '{print $1}'", timeoutMs: 5000 });
  const ids = list.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  if (ids.length) {
    await runExec({ command: ids.map((id) => `wmctrl -i -c ${id}`).join("; "), timeoutMs: 5000 });
    closedWindows = ids.length;
    await sleep(1500);
  }
  const killed: string[] = [];
  const leftovers = listProcs().filter((p) => p.uid === user.uid && !CORE.has(p.comm) && p.pid !== process.pid);
  // Only GUI apps and their helpers; leave shells/daemons of the session alone.
  for (const p of leftovers) {
    if (p.cmdline.includes("/opt/deskhand/") || p.cmdline.includes("supervisord")) continue;
    try {
      process.kill(p.pid, "SIGTERM");
      killed.push(`${p.comm}(${p.pid})`);
    } catch {
      /* gone */
    }
  }
  if (killed.length) {
    await sleep(1000);
    for (const p of listProcs().filter((q) => q.uid === user.uid && !CORE.has(q.comm))) {
      if (killed.some((k) => k.endsWith(`(${p.pid})`))) {
        try {
          process.kill(p.pid, "SIGKILL");
        } catch {
          /* gone */
        }
      }
    }
  }

  // 3. Caches, downloads, temp files.
  const mounts = mountPoints();
  const home = user.home;
  const targets: [string, Set<string>][] = [
    [join(home, ".cache"), new Set()],
    [join(home, "Downloads"), new Set()],
    ["/tmp", TMP_KEEP],
    ["/var/tmp", new Set()],
  ];
  const profileCaches = ["Cache", "Code Cache", "GPUCache", "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache", "Service Worker/CacheStorage", "Service Worker/ScriptCache"];
  const chromeRoot = join(home, ".config/chromium");
  let profiles: string[] = [];
  try {
    profiles = readdirSync(chromeRoot).filter((d) => d === "Default" || d.startsWith("Profile "));
  } catch {
    /* no profile yet */
  }
  for (const prof of profiles) for (const c of profileCaches) targets.push([join(chromeRoot, prof, c), new Set()]);
  for (const c of ["ShaderCache", "GrShaderCache", "GraphiteDawnCache", "component_crx_cache", "Crash Reports"]) targets.push([join(chromeRoot, c), new Set()]);
  const cleared: string[] = [];
  for (const [dir, keep] of targets) {
    const r = clearDir(dir, mounts, keep);
    if (r.removed) cleared.push(dir);
    for (const s of r.skipped) notes.push(`Kept ${s} (mount point or not removable).`);
  }
  log.info("quiesced", { chromiumClosed, closedWindows, killed: killed.length, cleared: cleared.length });
  return { ok: true, chromiumClosed, closedWindows, killed, cleared, notes };
}
