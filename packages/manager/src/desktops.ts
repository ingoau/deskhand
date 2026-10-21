/**
 * Desktop lifecycle (plan: "Manager service"): create/start/stop/remove containers, admission
 * control, idle stop, retention removal, health checks with restart, usage stats, lock proxying.
 * SQLite is the record; Docker labels let a restarted manager rediscover containers.
 */
import { EventEmitter } from "node:events";
import type { Logger } from "pino";
import {
  DAEMON_API_VERSION,
  DaemonClient,
  DeskhandError,
  LABELS,
  type Attention,
  type DaemonState,
  type DesktopHardware,
  type DesktopStatus,
  type DesktopSummary,
  type LastAction,
  type Mount,
  type TemplateHardware,
} from "@deskhand/shared";
import type { Config } from "./config.js";
import type { DB } from "./db.js";
import type { ContainerInfo, Runtime } from "./runtime/types.js";
import type { MountPolicy, ResolvedMount } from "./mounts.js";
import type { ActionLog } from "./actionlog.js";
import { formatMemory, type HardwareService } from "./hardware.js";
import { formatDuration, KeyedMutex, nowIso, randomId, secret, sleep } from "./util.js";

export type StopReason = "idle" | "user" | "agent" | "exited" | "unhealthy" | "manager";
export type RemoveReason = "agent" | "user" | "session_end" | "retention" | "missing" | "failed" | "template_build";

export interface StoredMount extends Mount {
  source: string;
}

export interface Desktop {
  id: string;
  name: string;
  containerId: string | null;
  sessionId: string | null;
  sessionLabel: string | null;
  sessionIndex: number;
  title: string | null;
  template: string;
  templateVersion: number;
  image: string;
  persistent: boolean;
  mounts: StoredMount[];
  screen: { width: number; height: number };
  daemonKey: string;
  status: DesktopStatus | "removed";
  stopReason: StopReason | null;
  createdAt: string;
  startedAt: string | null;
  stoppedAt: string | null;
  lastActivityAt: string | null;
  removedAt: string | null;
  removeReason: RemoveReason | null;
  attention: Attention | null;
  lastAction: LastAction | null;
  error: string | null;
  /** Memory/CPU caps and KVM (phase 6). Kept across restarts and recreations. */
  hardware: DesktopHardware;
}

interface Live {
  daemonUrl: string | null;
  state: DaemonState | null;
  unhealthySince: number | null;
  cpuPercent: number | null;
  hostCpuPercent: number | null;
  memoryBytes: number | null;
  diskBytes: number | null;
  /** Notes for the owning session's next tool result. */
  agentNotes: string[];
  /** The screen the agent last saw is gone (restart). */
  agentFresh: boolean;
}

export interface TemplateResolver {
  resolve(name?: string): { name: string; version: number; image: string };
  resolveVersion(name: string, version: number): { name: string; version: number; image: string } | null;
  /** Hardware recorded with a template version (phase 6); null when none. */
  hardwareOf?(name: string, version: number): TemplateHardware | null;
}

export interface CreateOptions {
  sessionId: string | null;
  sessionLabel: string | null;
  template?: string;
  name?: string;
  mounts?: Mount[];
  persistent?: boolean;
  screen?: { width: number; height: number };
  /** Phase 6: memory cap ("8g" or bytes), CPU cap and KVM. Omitted = template's recorded hardware, else defaults. */
  memory?: string | number;
  cpus?: number;
  kvm?: boolean;
  actor: string | null;
}

const ACTIVE: Array<Desktop["status"]> = ["starting", "running"];

function rowToDesktop(r: Record<string, unknown>): Desktop {
  return {
    id: r.id as string,
    name: r.name as string,
    containerId: (r.container_id as string) ?? null,
    sessionId: (r.session_id as string) ?? null,
    sessionLabel: (r.session_label as string) ?? null,
    sessionIndex: r.session_index as number,
    title: (r.title as string) ?? null,
    template: r.template as string,
    templateVersion: r.template_version as number,
    image: r.image as string,
    persistent: r.persistent === 1,
    mounts: JSON.parse(r.mounts as string) as StoredMount[],
    screen: { width: r.screen_w as number, height: r.screen_h as number },
    daemonKey: r.daemon_key as string,
    status: r.status as Desktop["status"],
    stopReason: (r.stop_reason as StopReason) ?? null,
    createdAt: r.created_at as string,
    startedAt: (r.started_at as string) ?? null,
    stoppedAt: (r.stopped_at as string) ?? null,
    lastActivityAt: (r.last_activity_at as string) ?? null,
    removedAt: (r.removed_at as string) ?? null,
    removeReason: (r.remove_reason as RemoveReason) ?? null,
    attention: r.attention ? (JSON.parse(r.attention as string) as Attention) : null,
    lastAction: r.last_action ? (JSON.parse(r.last_action as string) as LastAction) : null,
    error: (r.error as string) ?? null,
    // 0 = recorded before phase 6; filled with the configured defaults by the service.
    hardware: { memoryBytes: (r.memory_bytes as number) ?? 0, cpus: (r.cpus as number) ?? 0, kvm: r.kvm === 1 },
  };
}

export class DesktopService extends EventEmitter {
  private readonly desktops = new Map<string, Desktop>();
  private readonly live = new Map<string, Live>();
  private readonly mutex = new KeyedMutex();
  private timers: NodeJS.Timeout[] = [];
  private memoryBudget = 0;
  private hostCpus = 1;
  private stopping = false;

  constructor(
    private readonly cfg: Config,
    private readonly db: DB,
    private readonly runtime: Runtime,
    private readonly policy: MountPolicy,
    private readonly templates: TemplateResolver,
    private readonly actionLog: ActionLog,
    private readonly log: Logger,
    readonly hardware: HardwareService,
  ) {
    super();
    this.setMaxListeners(1000);
    for (const r of this.db.prepare("SELECT * FROM desktops").all() as Array<Record<string, unknown>>) {
      const d = rowToDesktop(r);
      if (!d.hardware.memoryBytes) d.hardware.memoryBytes = cfg.desktopMemoryBytes;
      if (!d.hardware.cpus) d.hardware.cpus = cfg.desktopCpus;
      this.desktops.set(d.id, d);
    }
  }

  get budgetBytes(): number {
    return this.memoryBudget;
  }

  setHostInfo(memoryBudget: number, cpus: number) {
    this.memoryBudget = memoryBudget;
    this.hostCpus = cpus;
    this.hardware.setHostCpus(cpus);
  }

  private liveOf(id: string): Live {
    let l = this.live.get(id);
    if (!l) {
      l = { daemonUrl: null, state: null, unhealthySince: null, cpuPercent: null, hostCpuPercent: null, memoryBytes: null, diskBytes: null, agentNotes: [], agentFresh: false };
      this.live.set(id, l);
    }
    return l;
  }

  private save(d: Desktop) {
    this.desktops.set(d.id, d);
    this.db
      .prepare(
        `INSERT INTO desktops (id, name, container_id, session_id, session_label, session_index, title, template, template_version, image, persistent,
           mounts, screen_w, screen_h, daemon_key, status, stop_reason, created_at, started_at, stopped_at, last_activity_at, removed_at, remove_reason,
           attention, last_action, error, memory_bytes, cpus, kvm)
         VALUES (@id, @name, @containerId, @sessionId, @sessionLabel, @sessionIndex, @title, @template, @templateVersion, @image, @persistent,
           @mounts, @w, @h, @daemonKey, @status, @stopReason, @createdAt, @startedAt, @stoppedAt, @lastActivityAt, @removedAt, @removeReason,
           @attention, @lastAction, @error, @memoryBytes, @cpus, @kvm)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, container_id=excluded.container_id, session_id=excluded.session_id,
           session_label=excluded.session_label, session_index=excluded.session_index, title=excluded.title, template=excluded.template,
           template_version=excluded.template_version, image=excluded.image, persistent=excluded.persistent, mounts=excluded.mounts,
           screen_w=excluded.screen_w, screen_h=excluded.screen_h, daemon_key=excluded.daemon_key, status=excluded.status,
           stop_reason=excluded.stop_reason, created_at=excluded.created_at, started_at=excluded.started_at, stopped_at=excluded.stopped_at,
           last_activity_at=excluded.last_activity_at, removed_at=excluded.removed_at, remove_reason=excluded.remove_reason,
           attention=excluded.attention, last_action=excluded.last_action, error=excluded.error,
           memory_bytes=excluded.memory_bytes, cpus=excluded.cpus, kvm=excluded.kvm`,
      )
      .run({
        ...d,
        hardware: undefined,
        memoryBytes: d.hardware.memoryBytes,
        cpus: d.hardware.cpus,
        kvm: d.hardware.kvm ? 1 : 0,
        persistent: d.persistent ? 1 : 0,
        mounts: JSON.stringify(d.mounts),
        w: d.screen.width,
        h: d.screen.height,
        attention: d.attention ? JSON.stringify(d.attention) : null,
        lastAction: d.lastAction ? JSON.stringify(d.lastAction) : null,
      });
    this.emit("changed", d.id);
  }

  // ---------------------------------------------------------------- startup / shutdown

  /** Reconciles the DB with containers found by label, then starts the background loops. */
  async init(): Promise<void> {
    try {
      await this.runtime.ping();
      const host = await this.runtime.hostInfo();
      this.setHostInfo(this.budgetFrom(host.memTotalBytes), host.ncpu);
      await this.reconcile();
    } catch (e) {
      this.log.error({ err: (e as Error).message }, "container engine not reachable at startup; will retry");
    }
    this.startLoops();
  }

  private budgetFrom(mem: number): number {
    return "bytes" in this.cfg.memoryBudget ? this.cfg.memoryBudget.bytes : Math.floor(mem * this.cfg.memoryBudget.fraction);
  }

  async reconcile(): Promise<void> {
    const containers = await this.runtime.listDesktops();
    const seen = new Set<string>();
    for (const c of containers) {
      const id = c.labels[LABELS.id];
      if (!id) continue;
      seen.add(id);
      let d = this.desktops.get(id);
      if (!d || d.status === "removed") {
        if (d?.status === "removed" && d.containerId === c.containerId) {
          // We meant to remove it; finish the job.
          await this.runtime.remove(c.containerId).catch(() => undefined);
          continue;
        }
        d = this.importContainer(id, c);
        this.log.info({ desktop: id }, "imported desktop container found by label");
      }
      d.containerId = c.containerId;
      const l = this.liveOf(id);
      if (c.running) {
        l.daemonUrl = c.daemonUrl;
        d.status = "running";
        d.startedAt = c.startedAt ?? d.startedAt;
      } else if (d.status !== "stopped") {
        d.status = "stopped";
        d.stopReason = d.stopReason ?? "exited";
        d.stoppedAt = c.finishedAt ?? nowIso();
      }
      this.save(d);
    }
    for (const d of this.desktops.values()) {
      if (d.status !== "removed" && !seen.has(d.id)) {
        this.log.warn({ desktop: d.id }, "desktop container is gone; marking removed");
        this.markRemoved(d, "missing");
      }
    }
  }

  private importContainer(id: string, c: ContainerInfo): Desktop {
    const [w, h] = (c.env.DESKHAND_SCREEN ?? "1280x800").split("x").map(Number);
    const d: Desktop = {
      id,
      name: c.name,
      containerId: c.containerId,
      sessionId: c.labels[LABELS.session] || null,
      sessionLabel: null,
      sessionIndex: 0,
      title: c.labels[LABELS.title] || null,
      template: c.labels[LABELS.template] || "base",
      templateVersion: Number(c.labels[LABELS.templateVersion] ?? 1),
      image: c.image,
      persistent: c.labels[LABELS.persistent] === "true",
      mounts: c.binds.map((b) => ({ path: b.target, write: b.write, source: b.source })),
      screen: { width: w ?? 1280, height: h ?? 800 },
      daemonKey: c.env.DESKHAND_DAEMON_KEY ?? "",
      status: c.running ? "running" : "stopped",
      stopReason: c.running ? null : "exited",
      createdAt: c.labels[LABELS.created] ?? nowIso(),
      startedAt: c.startedAt,
      stoppedAt: c.running ? null : c.finishedAt,
      lastActivityAt: nowIso(),
      removedAt: null,
      removeReason: null,
      attention: null,
      lastAction: null,
      error: null,
      hardware: { memoryBytes: c.memoryBytes ?? this.cfg.desktopMemoryBytes, cpus: c.cpus ?? this.cfg.desktopCpus, kvm: !!c.kvm },
    };
    this.save(d);
    return d;
  }

  private startLoops() {
    const every = (ms: number, fn: () => Promise<void>) => {
      let running = false;
      const t = setInterval(() => {
        if (running || this.stopping) return;
        running = true;
        fn()
          .catch((e) => this.log.warn({ err: (e as Error).message }, "background task failed"))
          .finally(() => (running = false));
      }, ms);
      t.unref();
      this.timers.push(t);
    };
    every(this.cfg.healthIntervalMs, () => this.healthTick());
    every(this.cfg.sweepIntervalMs, () => this.sweep());
    every(this.cfg.statsIntervalMs, () => this.statsTick());
    every(60_000, () => this.diskTick());
    every(Math.min(3_600_000, Math.max(this.cfg.sweepIntervalMs, this.cfg.logRetentionMs / 24)), async () => this.pruneLog());
  }

  async close(): Promise<void> {
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.flushActivity();
  }

  // ---------------------------------------------------------------- queries

  get(id: string): Desktop | undefined {
    const d = this.desktops.get(id);
    return d && d.status !== "removed" ? d : undefined;
  }

  getAny(id: string): Desktop | undefined {
    return this.desktops.get(id);
  }

  require(id: string): Desktop {
    const d = this.get(id);
    if (!d) throw new DeskhandError("desktop_not_found", `No desktop with id ${id}.`);
    return d;
  }

  list(): Desktop[] {
    return [...this.desktops.values()].filter((d) => d.status !== "removed").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Every desktop (including removed) that belongs to a session, by sessionIndex. */
  forSession(sessionId: string): Desktop[] {
    return [...this.desktops.values()].filter((d) => d.sessionId === sessionId).sort((a, b) => a.sessionIndex - b.sessionIndex);
  }

  removedIds(): Set<string> {
    return new Set([...this.desktops.values()].filter((d) => d.status === "removed").map((d) => d.id));
  }

  liveState(id: string): DaemonState | null {
    return this.live.get(id)?.state ?? null;
  }

  summary(d: Desktop): DesktopSummary {
    const l = this.live.get(d.id);
    const running = d.status === "running";
    return {
      id: d.id,
      name: d.name,
      title: d.title,
      session: d.sessionLabel,
      sessionIndex: d.sessionIndex,
      template: d.template,
      templateVersion: d.templateVersion,
      status: d.status === "removed" ? "removing" : d.status,
      persistent: d.persistent,
      attention: d.attention,
      lock: running ? (l?.state?.lock ?? null) : null,
      generation: l?.state?.generation ?? 0,
      lastHandback: l?.state?.lastHandback ?? null,
      lastAction: d.lastAction,
      createdAt: d.createdAt,
      startedAt: d.startedAt,
      stoppedAt: d.stoppedAt,
      lastActivityAt: d.lastActivityAt,
      screen: d.screen,
      mounts: d.mounts.map((m) => ({ path: m.path, ...(m.write ? { write: true } : {}) })),
      cpuPercent: running ? (l?.cpuPercent ?? null) : null,
      memoryBytes: running ? (l?.memoryBytes ?? null) : null,
      diskBytes: l?.diskBytes ?? null,
      hardware: { ...d.hardware },
    };
  }

  systemUsage(): { running: number; cpuPercent: number; memoryUsedBytes: number } {
    let cpu = 0;
    let mem = 0;
    let running = 0;
    for (const d of this.list()) {
      if (!ACTIVE.includes(d.status)) continue;
      running++;
      const l = this.live.get(d.id);
      cpu += l?.hostCpuPercent ?? 0;
      mem += l?.memoryBytes ?? 0;
    }
    return { running, cpuPercent: Math.round(cpu * 10) / 10, memoryUsedBytes: mem };
  }

  daemon(d: Desktop): DaemonClient {
    const url = this.live.get(d.id)?.daemonUrl;
    if (d.status !== "running" || !url) throw new DeskhandError("desktop_stopped", `Desktop ${d.id} is not running.`);
    return new DaemonClient({ baseUrl: url, key: d.daemonKey });
  }

  /** Notes (and the fresh flag) queued for the owning session, consumed on read. */
  takeAgentNotes(id: string): { notes: string[]; fresh: boolean } {
    const l = this.live.get(id);
    if (!l) return { notes: [], fresh: false };
    const out = { notes: l.agentNotes, fresh: l.agentFresh };
    l.agentNotes = [];
    l.agentFresh = false;
    return out;
  }

  // ---------------------------------------------------------------- admission

  /** Admission for one more desktop with `memoryBytes` (default: the configured default): desktop limit and memory budget. */
  private admissionError(memoryBytes = this.cfg.desktopMemoryBytes): DeskhandError | null {
    const activeDesktops = this.list().filter((d) => ACTIVE.includes(d.status));
    const active = activeDesktops.length;
    if (active + 1 > this.cfg.maxDesktops) {
      return new DeskhandError("limit_reached", `Desktop limit reached (${this.cfg.maxDesktops}). Stop one with \`desktop_stop\` or wait.`, {
        running: active,
        max: this.cfg.maxDesktops,
      });
    }
    // Budget by each desktop's own memory cap (per-desktop memory, phase 6).
    const reserved = activeDesktops.reduce((n, d) => n + d.hardware.memoryBytes, 0);
    if (this.memoryBudget > 0 && reserved + memoryBytes > this.memoryBudget) {
      const free = Math.max(0, this.memoryBudget - reserved);
      return new DeskhandError(
        "limit_reached",
        `Desktop limit reached: the memory budget (${formatMemory(this.memoryBudget)}, ${formatMemory(free)} free) has no room for another ${formatMemory(memoryBytes)} desktop. Stop one with \`desktop_stop\`, wait, or ask for less memory.`,
        { running: active, memoryBudgetBytes: this.memoryBudget, memoryFreeBytes: free, memoryBytes },
      );
    }
    return null;
  }

  /** Pure check used by tests and the API. */
  checkAdmission(memoryBytes?: number): void {
    const e = this.admissionError(memoryBytes);
    if (e) throw e;
  }

  // ---------------------------------------------------------------- create / start

  async create(opts: CreateOptions, reuse?: Desktop, hooks: { onInserted?: (id: string) => void } = {}): Promise<Desktop> {
    const tpl = reuse ? (this.templates.resolveVersion(reuse.template, reuse.templateVersion) ?? this.templates.resolve(reuse.template)) : this.templates.resolve(opts.template);
    const mounts: ResolvedMount[] = await this.policy.checkMounts(opts.mounts ?? []);
    const screen = opts.screen ?? this.cfg.screen;
    const hw = await this.hardware.resolve(
      { memory: opts.memory, cpus: opts.cpus, kvm: opts.kvm },
      { name: tpl.name, hardware: this.templates.hardwareOf?.(tpl.name, tpl.version) ?? null },
      reuse?.hardware,
    );
    await this.runtime.ping();
    await this.runtime.ensureImage(tpl.image);

    const d = await this.mutex.run("admission", async () => {
      this.checkAdmission(hw.memoryBytes);
      const id = reuse?.id ?? this.newId();
      const sessionIndex = reuse?.sessionIndex ?? (opts.sessionId ? Math.max(-1, ...this.forSession(opts.sessionId).map((x) => x.sessionIndex)) + 1 : 0);
      const now = nowIso();
      const desk: Desktop = {
        id,
        name: `${this.cfg.containerPrefix}${id}`,
        containerId: null,
        sessionId: opts.sessionId,
        sessionLabel: opts.sessionLabel,
        sessionIndex,
        title: opts.name ?? reuse?.title ?? null,
        template: tpl.name,
        templateVersion: tpl.version,
        image: tpl.image,
        persistent: !!opts.persistent,
        mounts: mounts.map((m) => ({ path: m.target, write: m.write, source: m.source })),
        screen,
        daemonKey: secret(32),
        status: "starting",
        stopReason: null,
        createdAt: now,
        startedAt: null,
        stoppedAt: null,
        lastActivityAt: now,
        removedAt: null,
        removeReason: null,
        attention: null,
        lastAction: null,
        error: null,
        hardware: { memoryBytes: hw.memoryBytes, cpus: hw.cpus, kvm: hw.kvm },
      };
      this.save(desk);
      return desk;
    });
    this.live.delete(d.id);
    if (hw.notes.length) this.liveOf(d.id).agentNotes.push(...hw.notes);
    try {
      d.containerId = await this.runtime.createDesktop({
        id: d.id,
        name: d.name,
        image: d.image,
        env: this.envFor(d),
        labels: this.labelsFor(d),
        memoryBytes: d.hardware.memoryBytes,
        cpus: d.hardware.cpus,
        kvm: d.hardware.kvm,
        binds: d.mounts.map((m) => ({ source: m.source, target: m.path, write: !!m.write })),
      });
      this.save(d);
      await this.runtime.start(d.containerId);
      hooks.onInserted?.(d.id);
      await this.waitHealthy(d);
      d.status = "running";
      d.startedAt = nowIso();
      this.save(d);
      this.log.info({ desktop: d.id, template: d.template, session: d.sessionId }, "desktop started");
      return d;
    } catch (e) {
      this.log.warn({ desktop: d.id, err: (e as Error).message }, "desktop failed to start");
      if (d.containerId) await this.runtime.remove(d.containerId).catch(() => undefined);
      d.error = (e as Error).message;
      this.markRemoved(d, "failed");
      throw e;
    }
  }

  private newId(): string {
    for (;;) {
      const id = randomId(4);
      if (!this.desktops.has(id)) return id;
    }
  }

  private envFor(d: Desktop): Record<string, string> {
    const env: Record<string, string> = {
      DESKHAND_DAEMON_KEY: d.daemonKey,
      DESKHAND_SCREEN: `${d.screen.width}x${d.screen.height}`,
      AGENT_UID: String(this.cfg.agentUid),
      AGENT_GID: String(this.cfg.agentGid),
    };
    if (this.cfg.tz) env.TZ = this.cfg.tz;
    if (this.cfg.lang) env.LANG = this.cfg.lang;
    return env;
  }

  private labelsFor(d: Desktop): Record<string, string> {
    return {
      [LABELS.id]: d.id,
      [LABELS.session]: d.sessionId ?? "",
      [LABELS.title]: (d.title ?? "").slice(0, 200),
      [LABELS.template]: d.template,
      [LABELS.templateVersion]: String(d.templateVersion),
      [LABELS.created]: d.createdAt,
      [LABELS.persistent]: d.persistent ? "true" : "false",
    };
  }

  /** Waits for the daemon to answer /health and checks its API version. */
  private async waitHealthy(d: Desktop): Promise<void> {
    const deadline = Date.now() + this.cfg.startTimeoutMs;
    const l = this.liveOf(d.id);
    let lastErr: unknown;
    while (Date.now() < deadline) {
      const info = d.containerId ? await this.runtime.inspect(d.containerId) : null;
      if (!info) throw new DeskhandError("internal", "The desktop container disappeared while starting.");
      if (!info.running && info.state !== "created" && info.state !== "restarting") {
        throw new DeskhandError("daemon_unavailable", "The desktop container exited while starting; ask the user to check the deskhand logs.");
      }
      if (info.daemonUrl) {
        l.daemonUrl = info.daemonUrl;
        try {
          const client = new DaemonClient({ baseUrl: info.daemonUrl, key: d.daemonKey });
          const h = await client.health(2000);
          if (h.apiVersion !== DAEMON_API_VERSION) {
            throw new DeskhandError(
              "version_mismatch",
              `The desktop image (daemon API v${h.apiVersion}, deskhand ${h.version}) does not match this deskhand manager (API v${DAEMON_API_VERSION}); ask the user to update deskhand or the desktop image.`,
            );
          }
          l.state = await client.state(3000).catch(() => null);
          l.unhealthySince = null;
          return;
        } catch (e) {
          if (e instanceof DeskhandError && e.code === "version_mismatch") throw e;
          lastErr = e;
        }
      }
      await sleep(200);
    }
    throw new DeskhandError("daemon_unavailable", "The desktop did not become ready in time; try again, and ask the user to check the deskhand logs if it repeats.", {
      cause: (lastErr as Error)?.message,
    });
  }

  /** Restarts a stopped desktop. Returns the agent-facing note, or null if it was already running. */
  async ensureRunning(id: string): Promise<string | null> {
    return this.mutex.run(`d:${id}`, async () => {
      const d = this.require(id);
      if (d.status === "running") {
        if (this.live.get(id)?.daemonUrl) return null;
        const info = d.containerId ? await this.runtime.inspect(d.containerId) : null;
        if (info?.running && info.daemonUrl) {
          this.liveOf(id).daemonUrl = info.daemonUrl;
          return null;
        }
        d.status = "stopped";
        d.stopReason = "exited";
      }
      if (d.status === "starting") throw new DeskhandError("daemon_unavailable", "The desktop is still starting; try again in a few seconds.");
      if (d.status === "error") throw new DeskhandError("daemon_unavailable", `The desktop is in an error state (${d.error ?? "unknown"}); stop it with desktop_stop and start a new one.`);
      const reason = d.stopReason;
      const info = d.containerId ? await this.runtime.inspect(d.containerId) : null;
      if (!info) {
        this.markRemoved(d, "missing");
        throw new DeskhandError("desktop_not_found", "That desktop's container is gone. Call `desktop_start` to create a new one.");
      }
      await this.mutex.run("admission", async () => {
        this.checkAdmission(d.hardware.memoryBytes);
        d.status = "starting";
        this.save(d);
      });
      try {
        await this.runtime.ensureImage(d.image).catch(() => undefined);
        await this.runtime.start(d.containerId!);
        await this.waitHealthy(d);
      } catch (e) {
        d.status = "stopped";
        this.save(d);
        throw e;
      }
      d.status = "running";
      d.startedAt = nowIso();
      d.stoppedAt = null;
      d.stopReason = null;
      d.lastActivityAt = nowIso();
      this.save(d);
      this.actionLog.record({ desktopId: d.id, tool: "restart", summary: `restarted (${reason ?? "stopped"})`, outcome: "ok", actor: null, session: null });
      return restartNote(reason, this.cfg.idleTimeoutMs);
    });
  }

  // ---------------------------------------------------------------- stop / remove

  async stop(id: string, reason: StopReason): Promise<Desktop> {
    return this.mutex.run(`d:${id}`, async () => {
      const d = this.require(id);
      if (d.status === "stopped") return d;
      await this.releaseButtons(d);
      if (d.containerId) await this.runtime.stop(d.containerId);
      d.status = "stopped";
      d.stopReason = reason;
      d.stoppedAt = nowIso();
      d.attention = null;
      const l = this.liveOf(id);
      l.daemonUrl = null;
      l.state = null;
      this.save(d);
      this.log.info({ desktop: id, reason }, "desktop stopped");
      this.emit("stopped", id);
      return d;
    });
  }

  async remove(id: string, reason: RemoveReason): Promise<void> {
    await this.mutex.run(`d:${id}`, async () => {
      const d = this.get(id);
      if (!d) return;
      await this.releaseButtons(d);
      d.status = "removed";
      this.save(d);
      if (d.containerId) await this.runtime.remove(d.containerId);
      this.markRemoved(d, reason);
      this.log.info({ desktop: id, reason }, "desktop removed");
    });
  }

  private markRemoved(d: Desktop, reason: RemoveReason) {
    d.status = "removed";
    d.removedAt = nowIso();
    d.removeReason = reason;
    d.attention = null;
    this.live.delete(d.id);
    this.save(d);
    this.emit("removed", d.id);
  }

  /** Releases a held mouse button (stuck-button safety on stop and session end). */
  private async releaseButtons(d: Desktop) {
    if (d.status !== "running") return;
    const st = this.live.get(d.id)?.state;
    if (!st || st.heldButtons.length === 0) return;
    try {
      await this.daemon(d).input({ input: { action: "left_mouse_up" }, screenshot: false, actor: "deskhand" }, 5000);
    } catch {
      /* best effort */
    }
  }

  /** MCP session ended: remove its ephemeral desktops; persistent ones stay, with buttons released. */
  async sessionEnded(sessionId: string): Promise<void> {
    for (const d of this.forSession(sessionId)) {
      if (d.status === "removed") continue;
      if (d.persistent) {
        await this.releaseButtons(d);
        d.attention = null;
        this.save(d);
      } else {
        await this.remove(d.id, "session_end").catch((e) => this.log.warn({ desktop: d.id, err: (e as Error).message }, "remove failed"));
      }
    }
  }

  // ---------------------------------------------------------------- mutations

  private activityDirty = new Set<string>();
  touch(id: string) {
    const d = this.desktops.get(id);
    if (!d) return;
    d.lastActivityAt = nowIso();
    this.activityDirty.add(id);
    if (this.activityDirty.size === 1 && !this.stopping) setTimeout(() => this.flushActivity(), 1000).unref();
  }

  private flushActivity() {
    if (this.activityDirty.size === 0 || !this.db.open) return;
    const stmt = this.db.prepare("UPDATE desktops SET last_activity_at = ? WHERE id = ?");
    for (const id of this.activityDirty) {
      const d = this.desktops.get(id);
      if (d) stmt.run(d.lastActivityAt, id);
    }
    this.activityDirty.clear();
  }

  setLastAction(id: string, a: LastAction) {
    const d = this.desktops.get(id);
    if (!d) return;
    d.lastAction = a;
    this.db.prepare("UPDATE desktops SET last_action = ? WHERE id = ?").run(JSON.stringify(a), id);
  }

  setTitle(id: string, title: string | null): Desktop {
    const d = this.require(id);
    d.title = title;
    this.save(d);
    return d;
  }

  setPersistent(id: string, persistent: boolean): Desktop {
    const d = this.require(id);
    d.persistent = persistent;
    this.save(d);
    return d;
  }

  /** Re-attaches a desktop to another session (persistent desktops). */
  attach(id: string, sessionId: string, sessionLabel: string | null): Desktop {
    const d = this.require(id);
    if (d.sessionId !== sessionId) {
      d.sessionIndex = Math.max(-1, ...this.forSession(sessionId).map((x) => x.sessionIndex)) + 1;
      d.sessionId = sessionId;
      d.sessionLabel = sessionLabel;
      this.save(d);
    }
    return d;
  }

  setAttention(id: string, attention: Attention | null) {
    const d = this.desktops.get(id);
    if (!d) return;
    d.attention = attention;
    this.save(d);
    this.emit("attention", id, attention);
  }

  /** The human dismissed a request_human flag without taking over. */
  dismissAttention(id: string, note: string | null) {
    const d = this.require(id);
    d.attention = null;
    this.save(d);
    this.emit("dismissed", id, note);
  }

  async lock(id: string, holder: string): Promise<DaemonState | null> {
    const d = this.require(id);
    const res = await this.daemon(d).lock(holder);
    return this.refreshState(d, res.generation);
  }

  async unlock(id: string, note: string | null): Promise<DaemonState | null> {
    const d = this.require(id);
    const res = await this.daemon(d).unlock(note);
    const st = await this.refreshState(d, res.generation);
    d.attention = null;
    this.save(d);
    this.emit("handback", id, { generation: res.generation, note });
    return st;
  }

  async refreshState(d: Desktop, _generation?: number): Promise<DaemonState | null> {
    try {
      const st = await this.daemon(d).state();
      this.liveOf(d.id).state = st;
      this.emit("changed", d.id);
      return st;
    } catch {
      return this.live.get(d.id)?.state ?? null;
    }
  }

  // ---------------------------------------------------------------- background loops

  async healthTick(): Promise<void> {
    for (const d of this.list()) {
      if (d.status !== "running") continue;
      const l = this.liveOf(d.id);
      try {
        if (!l.daemonUrl) throw new Error("no daemon url");
        l.state = await this.daemon(d).state(3000);
        l.unhealthySince = null;
      } catch {
        const info = d.containerId ? await this.runtime.inspect(d.containerId).catch(() => undefined) : null;
        if (info === null) {
          this.markRemoved(d, "missing");
          continue;
        }
        if (info && !info.running) {
          await this.mutex.run(`d:${d.id}`, async () => {
            if (d.status !== "running") return;
            d.status = "stopped";
            d.stopReason = "exited";
            d.stoppedAt = info.finishedAt ?? nowIso();
            l.daemonUrl = null;
            l.state = null;
            this.save(d);
          });
          this.log.warn({ desktop: d.id }, "desktop container exited");
          continue;
        }
        if (info?.daemonUrl) l.daemonUrl = info.daemonUrl;
        l.unhealthySince ??= Date.now();
        if (Date.now() - l.unhealthySince >= this.cfg.unhealthyAfterMs) await this.restartUnhealthy(d);
      }
    }
  }

  private async restartUnhealthy(d: Desktop) {
    await this.mutex.run(`d:${d.id}`, async () => {
      if (d.status !== "running" || !d.containerId) return;
      this.log.warn({ desktop: d.id }, "desktop unhealthy; restarting");
      const l = this.liveOf(d.id);
      d.status = "starting";
      this.save(d);
      try {
        await this.runtime.restart(d.containerId);
        await this.waitHealthy(d);
        d.status = "running";
        d.startedAt = nowIso();
        l.agentNotes.push("This desktop stopped responding, so deskhand restarted it; open windows were closed, files are kept.");
        l.agentFresh = true;
        this.actionLog.record({ desktopId: d.id, tool: "restart", summary: "restarted (unhealthy)", outcome: "ok", actor: null, session: null });
      } catch (e) {
        d.status = "error";
        d.error = `restart after health check failed: ${(e as Error).message}`;
      }
      l.unhealthySince = null;
      this.save(d);
    });
  }

  async sweep(now = Date.now()): Promise<void> {
    this.flushActivity();
    for (const d of this.list()) {
      if (d.status === "running") {
        const last = Date.parse(d.lastActivityAt ?? d.startedAt ?? d.createdAt);
        const locked = !!this.live.get(d.id)?.state?.lock;
        if (now - last >= this.cfg.idleTimeoutMs && !locked && !d.attention) {
          await this.stop(d.id, "idle").catch((e) => this.log.warn({ desktop: d.id, err: (e as Error).message }, "idle stop failed"));
        }
      } else if (d.status === "stopped" && !d.persistent) {
        const since = Date.parse(d.stoppedAt ?? d.createdAt);
        if (now - since >= this.cfg.stoppedRetentionMs) {
          await this.remove(d.id, "retention").catch((e) => this.log.warn({ desktop: d.id, err: (e as Error).message }, "retention removal failed"));
        }
      }
    }
  }

  async statsTick(): Promise<void> {
    await Promise.all(
      this.list()
        .filter((d) => d.status === "running" && d.containerId)
        .map(async (d) => {
          const s = await this.runtime.stats(d.containerId!);
          const l = this.liveOf(d.id);
          l.cpuPercent = s ? Math.round(s.cpuPercent * 10) / 10 : null;
          l.hostCpuPercent = s?.hostCpuPercent ?? null;
          l.memoryBytes = s?.memoryBytes ?? null;
        }),
    );
  }

  async diskTick(): Promise<void> {
    const usage = await this.runtime.diskUsage();
    for (const d of this.list()) if (d.containerId && usage.has(d.containerId)) this.liveOf(d.id).diskBytes = usage.get(d.containerId)!;
  }

  pruneLog() {
    this.actionLog.prune({ fullMs: this.cfg.logRetentionMs, thumbMs: this.cfg.logThumbRetentionMs, removedDesktopIds: () => this.removedIds() });
  }
}

export function restartNote(reason: StopReason | null, idleMs: number): string {
  const tail = "open windows were closed, files are kept.";
  switch (reason) {
    case "idle":
      return `This desktop was stopped after ${formatDuration(idleMs)} idle and restarted; ${tail}`;
    case "user":
      return `This desktop was stopped from the deskhand dashboard and has been restarted; ${tail}`;
    case "agent":
      return `This desktop had been stopped with desktop_stop and has been restarted; ${tail}`;
    case "unhealthy":
      return `This desktop stopped responding, so deskhand restarted it; ${tail}`;
    default:
      return `This desktop had stopped (the deskhand host may have restarted) and has been restarted; ${tail}`;
  }
}
