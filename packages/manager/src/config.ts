import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, DESKHAND_VERSION } from "@deskhand/shared";
import { normalizeBasePath, parseBytes, parseDuration } from "./util.js";

export interface Config {
  version: string;
  maxDesktops: number;
  /** Absolute bytes, or a fraction of host memory resolved at startup. */
  memoryBudget: { bytes: number } | { fraction: number };
  desktopMemoryBytes: number;
  desktopCpus: number;
  /** Upper bounds for per-desktop `memory`/`cpus` (DESKHAND_DESKTOP_MAX_MEMORY / _MAX_CPUS). */
  desktopMaxMemoryBytes: number;
  desktopMaxCpus: number;
  /** DESKHAND_KVM: auto = desktops may request /dev/kvm when the Docker host has it; off = never. */
  kvm: "auto" | "off";
  idleTimeoutMs: number;
  stoppedRetentionMs: number;
  /** MCP sessions without requests for this long are ended (their ephemeral desktops removed). */
  sessionTimeoutMs: number;
  /** A session whose client's event stream closed and stayed closed this long ends (0 = never). */
  sessionDisconnectGraceMs: number;
  logRetentionMs: number;
  /** Thumbnails and log rows of removed desktops are deleted after this. */
  logThumbRetentionMs: number;
  templateVersions: number;
  /** Image repository for template versions (`<repo>:<name>-v<N>`). */
  templateRepo: string;
  /** A template not confirmed working (ok feedback) for this long is marked stale. */
  templateStaleMs: number;
  /** Home-relative paths carried from the old snapshot when a recipe-backed template is rebuilt. */
  templateCarryPaths: string[];
  /** Rebuild recipe-backed templates automatically when the desktop image changes. */
  templateAutoRebuild: boolean;
  /** Time limit for one recipe run during a rebuild. */
  recipeTimeoutMs: number;
  /** Where users reach the manager (DESKHAND_BIND; in compose: the published host address). */
  bind: { host: string; port: number };
  /** Where the process listens: DESKHAND_LISTEN, else `bind` (compose sets 0.0.0.0:7480). */
  listen: { host: string; port: number };
  /** DESKHAND_LISTEN was set, so `bind` is the published address rather than the listen address. */
  listenSeparate: boolean;
  basePath: string;
  auth: boolean;
  /** Public origin + base, used in printed login links, e.g. https://desk.example.ts.net */
  publicUrl: string | null;
  tz: string | null;
  lang: string | null;
  dataDir: string;
  desktopImage: string;
  network: string;
  mountAllow: string[];
  mountDeny: string[];
  /** Host paths of the Docker socket (always refused as mounts, with their ancestors). */
  dockerSocketPaths: string[];
  ownerLabel: string;
  instance: string | null;
  containerPrefix: string;
  runtime: "docker" | "fake";
  dashboardDir: string | null;
  screenshot: { maxBytes: number; jpegQuality: number; minJpegQuality: number };
  requestHumanTimeoutMs: number;
  healthIntervalMs: number;
  unhealthyAfterMs: number;
  sweepIntervalMs: number;
  statsIntervalMs: number;
  startTimeoutMs: number;
  helperImage: string;
  /**
   * Chrome's seccomp profile (minified JSON text) for desktops, so Chromium's sandbox works; null when
   * DESKHAND_CHROME_SANDBOX=off. Sent with apparmor=unconfined (see docs/design.md, "Chromium sandbox").
   */
  chromeSeccomp: string | null;
  agentUid: number;
  agentGid: number;
  screen: { width: number; height: number };
  fileMaxBytes: number;
  /** Trust X-Forwarded-Proto/Host from a reverse proxy. */
  trustProxy: boolean;
  logLevel: string;
  /** Re-export Playwright MCP's browser_* tools (DESKHAND_BROWSER_TOOLS, default on). */
  browserTools: boolean;
  /** How long browser_* calls wait while the user holds the takeover lock (the daemon does this for pixel input and exec). */
  lockWaitMs: number;
}

type Env = Record<string, string | undefined>;

function list(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      if (!s.startsWith("/")) throw new Error(`mount allow/deny entries must be absolute paths: "${s}"`);
      return path.posix.normalize(s).replace(/(.)\/$/, "$1");
    });
}

function bool(v: string | undefined, dflt: boolean, name: string): boolean {
  if (v === undefined || v === "") return dflt;
  const s = v.trim().toLowerCase();
  if (["1", "on", "true", "yes"].includes(s)) return true;
  if (["0", "off", "false", "no"].includes(s)) return false;
  throw new Error(`${name} must be on or off, got "${v}"`);
}

function int(v: string | undefined, dflt: number, name: string, min = 0): number {
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}, got "${v}"`);
  return n;
}

function dur(v: string | undefined, dflt: string, name: string): number {
  try {
    return parseDuration(v && v.trim() ? v : dflt);
  } catch {
    throw new Error(`${name} must be a duration like 30m, 24h or 7d, got "${v}"`);
  }
}

export function parseBind(v: string | undefined): { host: string; port: number } {
  const s = (v ?? "").trim();
  if (!s) return { host: "127.0.0.1", port: DEFAULT_PORT };
  if (/^\d+$/.test(s)) return { host: "127.0.0.1", port: Number(s) };
  const m = /^(?:\[([^\]]+)\]|([^:]*)):(\d+)$/.exec(s);
  if (!m) throw new Error(`DESKHAND_BIND must look like 127.0.0.1:7480, got "${v}"`);
  return { host: m[1] ?? (m[2] || "0.0.0.0"), port: Number(m[3]) };
}

/**
 * DESKHAND_CHROME_SANDBOX=on (default): read DESKHAND_SECCOMP_PROFILE, else the manager image's copy,
 * else the repo's images/desktop/chrome-seccomp.json. Returned minified: the Docker API takes the
 * profile's JSON text in HostConfig.SecurityOpt (the CLI takes a path).
 */
export function loadChromeSeccomp(env: Env): string | null {
  if (!bool(env.DESKHAND_CHROME_SANDBOX, true, "DESKHAND_CHROME_SANDBOX")) return null;
  const explicit = env.DESKHAND_SECCOMP_PROFILE?.trim();
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = explicit ? [explicit] : ["/opt/deskhand/chrome-seccomp.json", path.resolve(here, "../../../images/desktop/chrome-seccomp.json")];
  for (const p of candidates) {
    let text: string;
    try {
      text = fs.readFileSync(p, "utf8");
    } catch {
      continue;
    }
    try {
      return JSON.stringify(JSON.parse(text));
    } catch {
      throw new Error(`the seccomp profile ${p} is not valid JSON`);
    }
  }
  throw new Error(
    explicit
      ? `DESKHAND_SECCOMP_PROFILE ${explicit} cannot be read`
      : "Chrome's seccomp profile (chrome-seccomp.json) was not found; set DESKHAND_SECCOMP_PROFILE, or DESKHAND_CHROME_SANDBOX=off",
  );
}

function templateRepo(v: string | undefined): string {
  const s = (v ?? "").trim() || "deskhand-template";
  if (!/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/.test(s)) throw new Error(`DESKHAND_TEMPLATE_REPO must be a lowercase image repository name, got "${v}"`);
  return s;
}

/**
 * What a rebuild carries over from the old snapshot (paths under the agent's home): browser
 * profiles (cookies, local storage, saved sessions, extensions installed from the browser), the
 * GNOME keyring and the NSS certificate store. Everything else comes from the new base + recipe.
 */
export const DEFAULT_CARRY_PATHS = [".config/chromium", ".mozilla", ".config/mozilla", ".local/share/keyrings", ".pki"];

function carryPaths(v: string | undefined): string[] {
  if (v === undefined || !v.trim()) return DEFAULT_CARRY_PATHS;
  return v
    .split(/[,\n]/)
    .map((s) => s.trim().replace(/^~\//, "").replace(/\/+$/, ""))
    .filter(Boolean)
    .map((s) => {
      if (s.startsWith("/") || s.split("/").includes("..")) throw new Error(`DESKHAND_TEMPLATE_CARRY entries are paths relative to the agent's home, got "${s}"`);
      return s;
    });
}

function defaultDashboardDir(): string {
  // packages/manager/{src,dist}/config.* -> packages/dashboard/dist
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../dashboard/dist");
}

export function parseConfig(env: Env = process.env): Config {
  const memBudget = (env.DESKHAND_MEMORY_BUDGET ?? "").trim();
  let memoryBudget: Config["memoryBudget"] = { fraction: 0.8 };
  if (memBudget) {
    const pct = /^(\d+(?:\.\d+)?)%$/.exec(memBudget);
    if (pct) memoryBudget = { fraction: Number(pct[1]) / 100 };
    else {
      try {
        memoryBudget = { bytes: parseBytes(memBudget) };
      } catch {
        throw new Error(`DESKHAND_MEMORY_BUDGET must be a size like 24g or a percentage like 80%, got "${memBudget}"`);
      }
    }
  }
  let desktopMemoryBytes: number;
  try {
    desktopMemoryBytes = parseBytes(env.DESKHAND_DESKTOP_MEMORY || "2g");
  } catch {
    throw new Error(`DESKHAND_DESKTOP_MEMORY must be a size like 2g, got "${env.DESKHAND_DESKTOP_MEMORY}"`);
  }
  const desktopCpus = Number(env.DESKHAND_DESKTOP_CPUS || "1.5");
  if (!(desktopCpus > 0)) throw new Error(`DESKHAND_DESKTOP_CPUS must be a positive number, got "${env.DESKHAND_DESKTOP_CPUS}"`);
  let desktopMaxMemoryBytes: number;
  try {
    desktopMaxMemoryBytes = parseBytes(env.DESKHAND_DESKTOP_MAX_MEMORY || "8g");
  } catch {
    throw new Error(`DESKHAND_DESKTOP_MAX_MEMORY must be a size like 8g, got "${env.DESKHAND_DESKTOP_MAX_MEMORY}"`);
  }
  if (desktopMaxMemoryBytes < desktopMemoryBytes) throw new Error("DESKHAND_DESKTOP_MAX_MEMORY must be at least DESKHAND_DESKTOP_MEMORY");
  const desktopMaxCpus = Number(env.DESKHAND_DESKTOP_MAX_CPUS || "4");
  if (!(desktopMaxCpus > 0)) throw new Error(`DESKHAND_DESKTOP_MAX_CPUS must be a positive number, got "${env.DESKHAND_DESKTOP_MAX_CPUS}"`);
  if (desktopMaxCpus < desktopCpus) throw new Error("DESKHAND_DESKTOP_MAX_CPUS must be at least DESKHAND_DESKTOP_CPUS");
  const kvm = (env.DESKHAND_KVM || "auto").trim().toLowerCase();
  if (kvm !== "auto" && kvm !== "off") throw new Error(`DESKHAND_KVM must be auto or off, got "${env.DESKHAND_KVM}"`);
  const screenM = /^(\d+)x(\d+)$/.exec(env.DESKHAND_SCREEN || "1280x800");
  if (!screenM) throw new Error(`DESKHAND_SCREEN must look like 1280x800`);
  const runtime = (env.DESKHAND_RUNTIME || "docker") as Config["runtime"];
  if (runtime !== "docker" && runtime !== "fake") throw new Error(`DESKHAND_RUNTIME must be docker or fake`);
  const idleTimeoutMs = dur(env.DESKHAND_IDLE_TIMEOUT, "30m", "DESKHAND_IDLE_TIMEOUT");
  const stoppedRetentionMs = dur(env.DESKHAND_STOPPED_RETENTION, "24h", "DESKHAND_STOPPED_RETENTION");
  const dashboardDir = env.DESKHAND_DASHBOARD_DIR === "" ? null : (env.DESKHAND_DASHBOARD_DIR ?? defaultDashboardDir());
  const publicUrl = env.DESKHAND_PUBLIC_URL ? env.DESKHAND_PUBLIC_URL.replace(/\/+$/, "") : null;
  if (publicUrl && !/^https?:\/\//.test(publicUrl)) throw new Error("DESKHAND_PUBLIC_URL must start with http:// or https://");
  return {
    version: DESKHAND_VERSION,
    maxDesktops: int(env.DESKHAND_MAX_DESKTOPS, 8, "DESKHAND_MAX_DESKTOPS", 1),
    memoryBudget,
    desktopMemoryBytes,
    desktopCpus,
    desktopMaxMemoryBytes,
    desktopMaxCpus,
    kvm,
    idleTimeoutMs,
    stoppedRetentionMs,
    sessionTimeoutMs: dur(env.DESKHAND_SESSION_TIMEOUT, "24h", "DESKHAND_SESSION_TIMEOUT"),
    sessionDisconnectGraceMs: ["0", "off"].includes((env.DESKHAND_SESSION_DISCONNECT_GRACE ?? "").trim())
      ? 0
      : dur(env.DESKHAND_SESSION_DISCONNECT_GRACE, "60s", "DESKHAND_SESSION_DISCONNECT_GRACE"),
    logRetentionMs: dur(env.DESKHAND_LOG_RETENTION, "7d", "DESKHAND_LOG_RETENTION"),
    logThumbRetentionMs: dur(env.DESKHAND_LOG_THUMB_RETENTION, "30d", "DESKHAND_LOG_THUMB_RETENTION"),
    templateVersions: int(env.DESKHAND_TEMPLATE_VERSIONS, 5, "DESKHAND_TEMPLATE_VERSIONS", 1),
    templateRepo: templateRepo(env.DESKHAND_TEMPLATE_REPO),
    templateStaleMs: dur(env.DESKHAND_TEMPLATE_STALE_AFTER, "14d", "DESKHAND_TEMPLATE_STALE_AFTER"),
    templateCarryPaths: carryPaths(env.DESKHAND_TEMPLATE_CARRY),
    templateAutoRebuild: bool(env.DESKHAND_TEMPLATE_AUTO_REBUILD, true, "DESKHAND_TEMPLATE_AUTO_REBUILD"),
    recipeTimeoutMs: dur(env.DESKHAND_RECIPE_TIMEOUT, "20m", "DESKHAND_RECIPE_TIMEOUT"),
    bind: parseBind(env.DESKHAND_BIND),
    listen: parseBind(env.DESKHAND_LISTEN || env.DESKHAND_BIND),
    listenSeparate: !!env.DESKHAND_LISTEN,
    basePath: normalizeBasePath(env.DESKHAND_BASE_PATH),
    auth: bool(env.DESKHAND_AUTH, true, "DESKHAND_AUTH"),
    publicUrl,
    tz: env.TZ || null,
    lang: env.LANG || null,
    dataDir: env.DESKHAND_DATA_DIR || "/data",
    desktopImage: env.DESKHAND_DESKTOP_IMAGE || `ghcr.io/ingoau/deskhand-desktop:${DESKHAND_VERSION}`,
    network: env.DESKHAND_NETWORK || "deskhand-desktops",
    mountAllow: list(env.DESKHAND_MOUNT_ALLOW),
    mountDeny: list(env.DESKHAND_MOUNT_DENY),
    dockerSocketPaths: list(env.DESKHAND_DOCKER_SOCKET_PATHS || "/var/run/docker.sock,/run/docker.sock"),
    ownerLabel: env.DESKHAND_OWNER_LABEL || "deskhand",
    instance: env.DESKHAND_INSTANCE || null,
    containerPrefix: env.DESKHAND_CONTAINER_PREFIX || "deskhand-",
    runtime,
    dashboardDir,
    screenshot: {
      maxBytes: parseBytes(env.DESKHAND_SCREENSHOT_MAX_BYTES || "72k"),
      jpegQuality: int(env.DESKHAND_SCREENSHOT_QUALITY, 80, "DESKHAND_SCREENSHOT_QUALITY", 1),
      minJpegQuality: 30,
    },
    requestHumanTimeoutMs: dur(env.DESKHAND_REQUEST_HUMAN_TIMEOUT, "10m", "DESKHAND_REQUEST_HUMAN_TIMEOUT"),
    healthIntervalMs: dur(env.DESKHAND_HEALTH_INTERVAL, "5s", "DESKHAND_HEALTH_INTERVAL"),
    unhealthyAfterMs: dur(env.DESKHAND_UNHEALTHY_AFTER, "60s", "DESKHAND_UNHEALTHY_AFTER"),
    sweepIntervalMs: dur(env.DESKHAND_SWEEP_INTERVAL, "15s", "DESKHAND_SWEEP_INTERVAL"),
    statsIntervalMs: dur(env.DESKHAND_STATS_INTERVAL, "5s", "DESKHAND_STATS_INTERVAL"),
    startTimeoutMs: dur(env.DESKHAND_START_TIMEOUT, "60s", "DESKHAND_START_TIMEOUT"),
    helperImage: env.DESKHAND_HELPER_IMAGE || "busybox:1.37",
    chromeSeccomp: runtime === "fake" ? null : loadChromeSeccomp(env),
    agentUid: int(env.DESKHAND_AGENT_UID, 1000, "DESKHAND_AGENT_UID"),
    agentGid: int(env.DESKHAND_AGENT_GID, 1000, "DESKHAND_AGENT_GID"),
    screen: { width: Number(screenM[1]), height: Number(screenM[2]) },
    fileMaxBytes: parseBytes(env.DESKHAND_FILE_MAX_BYTES || "512m"),
    trustProxy: bool(env.DESKHAND_TRUST_PROXY, true, "DESKHAND_TRUST_PROXY"),
    logLevel: env.DESKHAND_LOG_LEVEL || "info",
    browserTools: bool(env.DESKHAND_BROWSER_TOOLS, true, "DESKHAND_BROWSER_TOOLS"),
    lockWaitMs: dur(env.DESKHAND_LOCK_WAIT, "30s", "DESKHAND_LOCK_WAIT"),
  };
}

export function resolveMemoryBudget(cfg: Config, hostMemBytes: number): number {
  return "bytes" in cfg.memoryBudget ? cfg.memoryBudget.bytes : Math.floor(hostMemBytes * cfg.memoryBudget.fraction);
}
