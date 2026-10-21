/** The manager's implementation of the MCP package's backend interface. */
import type { Logger } from "pino";
import { DAEMON_API_VERSION, DeskhandError, type TemplateDescription } from "@deskhand/shared";
import type { DesktopRef, HumanWaitResult, McpBackend, Principal as McpPrincipal, ResolvedDesktop, SessionEndReason, SessionInfo, StartOptions } from "@deskhand/mcp";
import type { Config } from "./config.js";
import type { DB } from "./db.js";
import type { AuthService } from "./auth.js";
import type { Desktop, DesktopService } from "./desktops.js";
import type { TemplateService } from "./templates.js";
import type { ActionLog } from "./actionlog.js";
import type { MountPolicy } from "./mounts.js";
import type { Runtime } from "./runtime/types.js";
import { encodeForAgent } from "./images.js";
import { formatDuration, nowIso } from "./util.js";
import { saveDesktopAsTemplate } from "./template-ops.js";

export function toRef(d: Desktop): DesktopRef {
  return {
    id: d.id,
    title: d.title,
    template: d.template,
    templateVersion: d.templateVersion,
    status: d.status,
    persistent: d.persistent,
    sessionIndex: d.sessionIndex,
    screen: d.screen,
    mounts: d.mounts.map((m) => ({ path: m.path, ...(m.write ? { write: true } : {}) })),
    hardware: { ...d.hardware },
  };
}

export function sessionLabel(info: { id: string; principal: { name: string } }): string {
  return `${info.principal.name}/${info.id.slice(0, 4)}`;
}

/** Copies files between the deskhand host (via the runtime's helper) and a desktop (via its daemon). */
export class FileService {
  constructor(
    private readonly cfg: Config,
    private readonly runtime: Runtime,
    private readonly policy: MountPolicy,
    private readonly desktops: DesktopService,
  ) {}

  async put(d: Desktop, hostPath: string, desktopPath: string): Promise<{ bytes: number }> {
    const src = await this.policy.checkReadFile(hostPath);
    const data = await this.runtime.readHostFile(src, this.cfg.fileMaxBytes);
    return this.desktops.daemon(d).putFile(desktopPath, data);
  }

  async get(d: Desktop, desktopPath: string, hostPath: string): Promise<{ bytes: number }> {
    const dst = await this.policy.checkWriteFile(hostPath);
    const data = await this.desktops.daemon(d).getFile(desktopPath);
    if (data.length > this.cfg.fileMaxBytes) throw new DeskhandError("invalid_argument", `That file is larger than the ${this.cfg.fileMaxBytes}-byte limit.`);
    await this.runtime.writeHostFile(dst, data, this.cfg.agentUid, this.cfg.agentGid);
    return { bytes: data.length };
  }
}

export class ManagerMcpBackend implements McpBackend {
  readonly version: string;
  private touched = new Map<string, number>();

  constructor(
    private readonly cfg: Config,
    private readonly db: DB,
    private readonly auth: AuthService,
    private readonly desktops: DesktopService,
    private readonly templates: TemplateService,
    private readonly actionLog: ActionLog,
    private readonly files: FileService,
    private readonly log: Logger,
    private readonly runtime: Runtime,
  ) {
    this.version = cfg.version;
  }

  authenticate(authorization: string | undefined): McpPrincipal | null {
    const p = this.auth.authenticate({ authorization }, { allowCookie: false });
    if (!p) return null;
    if (p.kind === "token") return { kind: "token", tokenId: p.tokenId, name: p.name };
    if (p.kind === "admin") return { kind: "admin", name: p.name };
    return { kind: "none", name: p.name };
  }

  originAllowed(headers: Record<string, string | string[] | undefined>): boolean {
    return this.auth.originAllowed({ headers }, false);
  }

  principalActive(p: McpPrincipal): boolean {
    return p.kind === "token" && p.tokenId ? this.auth.isTokenActive(p.tokenId) : true;
  }

  // ---------------------------------------------------------------- sessions

  sessionOpened(info: SessionInfo): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO mcp_sessions (id, token_id, actor, client_name, client_version, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at, closed_at = NULL`,
      )
      .run(info.id, info.principal.tokenId ?? null, info.principal.name, info.clientName ?? null, info.clientVersion ?? null, now, now);
    this.log.info({ session: info.id, actor: info.principal.name, client: info.clientName }, "MCP session opened");
  }

  sessionTouched(sessionId: string): void {
    const last = this.touched.get(sessionId) ?? 0;
    if (Date.now() - last < 30_000) return;
    this.touched.set(sessionId, Date.now());
    this.db.prepare("UPDATE mcp_sessions SET last_seen_at = ? WHERE id = ?").run(nowIso(), sessionId);
  }

  async sessionClosed(sessionId: string, reason: SessionEndReason): Promise<void> {
    this.touched.delete(sessionId);
    this.db.prepare("UPDATE mcp_sessions SET closed_at = ?, close_reason = ? WHERE id = ?").run(nowIso(), reason, sessionId);
    this.log.info({ session: sessionId, reason }, "MCP session ended");
    await this.desktops.sessionEnded(sessionId);
  }

  knownSession(sessionId: string): { tokenId: string | null; actor: string } | null {
    const r = this.db.prepare("SELECT token_id, actor, last_seen_at FROM mcp_sessions WHERE id = ? AND closed_at IS NULL").get(sessionId) as
      | { token_id: string | null; actor: string; last_seen_at: string }
      | undefined;
    if (!r || Date.now() - Date.parse(r.last_seen_at) > this.cfg.sessionTimeoutMs) return null;
    return { tokenId: r.token_id, actor: r.actor };
  }

  private sessionOpen(sessionId: string | null): boolean {
    if (!sessionId) return false;
    return !!this.db.prepare("SELECT 1 FROM mcp_sessions WHERE id = ? AND closed_at IS NULL").get(sessionId);
  }

  // ---------------------------------------------------------------- desktops

  private async resolved(d: Desktop, notes: string[], fresh: boolean): Promise<ResolvedDesktop> {
    const restart = await this.desktops.ensureRunning(d.id);
    if (restart) {
      notes.push(restart);
      fresh = true;
    }
    const live = this.desktops.liveState(d.id);
    if (live && live.apiVersion !== DAEMON_API_VERSION) {
      throw new DeskhandError(
        "version_mismatch",
        `This desktop runs an older desktop image (daemon API v${live.apiVersion}, manager API v${DAEMON_API_VERSION}); ask the user to update it, or start a new desktop with desktop_start.`,
      );
    }
    const agent = this.desktops.takeAgentNotes(d.id);
    notes.push(...agent.notes);
    return { desktop: toRef(this.desktops.require(d.id)), daemon: this.desktops.daemon(this.desktops.require(d.id)), notes, fresh: fresh || agent.fresh };
  }

  private create(session: SessionInfo, opts: StartOptions) {
    return this.desktops.create({
      sessionId: session.id,
      sessionLabel: sessionLabel(session),
      template: opts.template,
      name: opts.name,
      mounts: opts.mounts,
      persistent: opts.persistent,
      memory: opts.memory,
      cpus: opts.cpus,
      kvm: opts.kvm,
      actor: session.principal.name,
    });
  }

  hardware() {
    return this.desktops.hardware.info();
  }

  async startDesktop(session: SessionInfo, opts: StartOptions): Promise<ResolvedDesktop> {
    if (opts.name) {
      const match = this.desktops
        .list()
        .find((d) => d.title === opts.name && (d.sessionId === session.id || (d.persistent && !this.sessionOpen(d.sessionId))));
      if (match) {
        this.desktops.attach(match.id, session.id, sessionLabel(session));
        if (opts.persistent && !match.persistent) this.desktops.setPersistent(match.id, true);
        const hwNote = opts.memory !== undefined || opts.cpus !== undefined || opts.kvm !== undefined ? ", and so are memory, CPUs and KVM" : "";
        return this.resolved(match, [`Reattached existing desktop ${match.id} ("${opts.name}"); mounts and template are the ones it was created with${hwNote}.`], true);
      }
    }
    const d = await this.create(session, opts);
    return this.resolved(d, [], true);
  }

  private target(session: SessionInfo, desktopId?: string): Desktop {
    if (desktopId) {
      const d = this.desktops.get(desktopId);
      if (!d || d.sessionId !== session.id) throw new DeskhandError("desktop_not_found", `This session has no desktop ${desktopId}. Call \`desktop_list\` to see your desktops.`);
      return d;
    }
    const d = this.desktops.forSession(session.id).find((x) => x.status !== "removed");
    if (!d) throw new DeskhandError("desktop_not_found", "This session has no desktop. Call `desktop_start` to create one.");
    return d;
  }

  async stopDesktop(session: SessionInfo, desktopId?: string): Promise<{ desktop: DesktopRef; action: "removed" | "stopped" }> {
    const d = this.target(session, desktopId);
    if (d.persistent) {
      const s = await this.desktops.stop(d.id, "agent");
      return { desktop: toRef(s), action: "stopped" };
    }
    await this.desktops.remove(d.id, "agent");
    return { desktop: toRef(this.desktops.getAny(d.id)!), action: "removed" };
  }

  async listDesktops(session: SessionInfo): Promise<DesktopRef[]> {
    return this.desktops
      .forSession(session.id)
      .filter((d) => d.status !== "removed")
      .map(toRef);
  }

  async setTitle(session: SessionInfo, desktopId: string | undefined, title: string): Promise<DesktopRef> {
    const rd = await this.resolveDesktop(session, desktopId);
    return toRef(this.desktops.setTitle(rd.desktop.id, title.trim() || null));
  }

  async resolveDesktop(session: SessionInfo, desktopId?: string): Promise<ResolvedDesktop> {
    if (desktopId) {
      const d = this.desktops.getAny(desktopId);
      if (!d) throw new DeskhandError("desktop_not_found", `There is no desktop ${desktopId}. Call \`desktop_list\` to see your desktops.`);
      if (d.sessionId !== session.id) {
        if (d.status !== "removed" && d.persistent && !this.sessionOpen(d.sessionId)) {
          this.desktops.attach(d.id, session.id, sessionLabel(session));
          return this.resolved(d, [`Reattached persistent desktop ${d.id}.`], true);
        }
        throw new DeskhandError("desktop_not_found", `This session has no desktop ${desktopId}. Call \`desktop_list\` to see your desktops.`);
      }
      if (d.status === "removed") {
        if (d.removeReason === "retention") return this.recreate(session, d);
        throw new DeskhandError("desktop_not_found", `Desktop ${desktopId} was removed. Call \`desktop_start\` to create a new one.`);
      }
      return this.resolved(d, [], false);
    }
    const mine = this.desktops.forSession(session.id);
    const live = mine.find((d) => d.status !== "removed");
    if (live) return this.resolved(live, [], false);
    const expired = mine.find((d) => d.removeReason === "retention");
    if (expired && !mine.some((d) => d.removeReason === "agent" && d.sessionIndex < expired.sessionIndex)) return this.recreate(session, expired);
    const d = await this.create(session, {});
    return this.resolved(d, [`Started desktop ${d.id} (template ${d.template} v${d.templateVersion}) for this session, since it had none. Use desktop_start for mounts or a different template.`], true);
  }

  private async recreate(session: SessionInfo, old: Desktop): Promise<ResolvedDesktop> {
    const d = await this.desktops.create(
      {
        sessionId: session.id,
        sessionLabel: sessionLabel(session),
        template: old.template,
        mounts: old.mounts.map((m) => ({ path: m.path, write: m.write })),
        persistent: false,
        actor: session.principal.name,
      },
      old,
    );
    return this.resolved(
      d,
      [
        `Your previous desktop ${old.id} was removed after ${formatDuration(this.cfg.stoppedRetentionMs)} stopped, so deskhand created a fresh one (same id) from template ${d.template} v${d.templateVersion}; files from the old desktop are gone.`,
      ],
      true,
    );
  }

  touchDesktop(desktopId: string): void {
    this.desktops.touch(desktopId);
  }

  recordAction(rec: Parameters<McpBackend["recordAction"]>[0]): void {
    const at = nowIso();
    this.actionLog.record({
      desktopId: rec.desktopId,
      tool: rec.tool,
      args: rec.args,
      summary: rec.summary,
      outcome: rec.outcome,
      error: rec.error,
      actor: rec.actor,
      // Same label the dashboard shows on tiles (`token/abcd`), not the raw session id.
      session: rec.sessionId && rec.actor ? sessionLabel({ id: rec.sessionId, principal: { name: rec.actor } }) : rec.sessionId,
      durationMs: rec.durationMs,
      overlays: rec.overlays,
      screenshot: rec.screenshot,
      at,
    });
    this.desktops.setLastAction(rec.desktopId, { tool: rec.tool, summary: rec.summary, at });
  }

  async encodeForAgent(image: Buffer) {
    const img = await encodeForAgent(image, this.cfg.screenshot);
    return { mimeType: img.mime, data: img.data.toString("base64"), width: img.width, height: img.height };
  }

  // ---------------------------------------------------------------- templates

  listTemplates() {
    return this.templates.list();
  }

  templateInfo(name: string) {
    return this.templates.info(name);
  }

  async saveTemplate(session: SessionInfo, desktopId: string, input: { name: string; description?: TemplateDescription; confirm_description?: boolean; recipe?: string }) {
    const d = this.desktops.require(desktopId);
    const r = await saveDesktopAsTemplate(
      { cfg: this.cfg, desktops: this.desktops, templates: this.templates, runtime: this.runtime, log: this.log },
      d,
      input,
      session.principal.name,
      true,
      sessionLabel(session),
    );
    return { ...r.template, notes: [...r.notes, ...r.manifest.notes] };
  }

  async templateFeedback(session: SessionInfo, desktopId: string, kind: "ok" | "problem", note: string) {
    const d = this.desktops.require(desktopId);
    this.templates.feedback(d.template, d.templateVersion, kind, note, session.principal.name, sessionLabel(session));
    return { template: d.template, version: d.templateVersion };
  }

  onTemplatesChanged(cb: () => void): () => void {
    this.templates.on("changed", cb);
    return () => this.templates.off("changed", cb);
  }

  // ---------------------------------------------------------------- files

  filePut(_s: SessionInfo, desktopId: string, hostPath: string, desktopPath: string) {
    return this.files.put(this.desktops.require(desktopId), hostPath, desktopPath);
  }

  fileGet(_s: SessionInfo, desktopId: string, desktopPath: string, hostPath: string) {
    return this.files.get(this.desktops.require(desktopId), desktopPath, hostPath);
  }

  // ---------------------------------------------------------------- request_human

  async requestHuman(
    _session: SessionInfo,
    desktopId: string,
    reason: string,
    opts: { signal: AbortSignal; onProgress: (elapsedMs: number, totalMs: number) => void },
  ): Promise<HumanWaitResult> {
    const d = this.desktops.require(desktopId);
    const daemon = this.desktops.daemon(d);
    const st = await daemon.state();
    const startGen = st.generation;
    const total = this.cfg.requestHumanTimeoutMs;
    const started = Date.now();
    this.desktops.setAttention(desktopId, { reason, since: nowIso(), timeoutAt: new Date(started + total).toISOString() });
    return new Promise<HumanWaitResult>((resolve) => {
      let done = false;
      const timers: NodeJS.Timeout[] = [];
      const finish = (r: HumanWaitResult) => {
        if (done) return;
        done = true;
        timers.forEach((t) => clearInterval(t));
        this.desktops.off("handback", onHandback);
        this.desktops.off("dismissed", onDismissed);
        this.desktops.off("stopped", onStopped);
        this.desktops.off("removed", onStopped);
        opts.signal.removeEventListener("abort", onAbort);
        resolve(r);
      };
      const onHandback = (id: string, hb: { generation: number; note: string | null }) => {
        if (id === desktopId && hb.generation > startGen) finish({ outcome: "handed_back", note: hb.note, generation: hb.generation });
      };
      const onDismissed = (id: string, note: string | null) => {
        if (id === desktopId) finish({ outcome: "dismissed", note, generation: null });
      };
      const onStopped = (id: string) => {
        if (id === desktopId) finish({ outcome: "stopped", note: null, generation: null });
      };
      const onAbort = () => {
        this.desktops.setAttention(desktopId, null);
        finish({ outcome: "timeout", note: null, generation: null });
      };
      this.desktops.on("handback", onHandback);
      this.desktops.on("dismissed", onDismissed);
      this.desktops.on("stopped", onStopped);
      this.desktops.on("removed", onStopped);
      opts.signal.addEventListener("abort", onAbort);
      // Poll as a fallback (a hand-back that did not go through this manager process).
      timers.push(
        setInterval(async () => {
          const s = await daemon.state().catch(() => null);
          if (s && !s.lock && s.generation > startGen && s.lastHandback && s.lastHandback.generation > startGen) {
            finish({ outcome: "handed_back", note: s.lastHandback.note, generation: s.generation });
          }
        }, 2000),
      );
      timers.push(setInterval(() => opts.onProgress(Date.now() - started, total), 15_000));
      timers.push(
        setInterval(() => {
          if (Date.now() - started >= total) finish({ outcome: "timeout", note: null, generation: null });
        }, Math.min(1000, total)),
      );
      opts.onProgress(0, total);
    });
  }

  clearAttention(desktopId: string): void {
    if (this.desktops.get(desktopId)?.attention) this.desktops.setAttention(desktopId, null);
  }
}

export { saveDesktopAsTemplate } from "./template-ops.js";
