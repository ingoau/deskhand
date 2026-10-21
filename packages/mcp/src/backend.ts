/**
 * What the MCP server needs from the manager. The manager implements this; tests can fake it.
 * Keeping it narrow keeps the MCP package free of Docker/SQLite concerns.
 */
import type {
  DaemonClient,
  DesktopHardware,
  DesktopStatus,
  HardwareInfo,
  Mount,
  Overlay,
  TemplateDescription,
  TemplateDetail,
  TemplateSummary,
} from "@deskhand/shared";

export interface Principal {
  kind: "token" | "cookie" | "admin" | "none";
  /** Token id, when kind is token. */
  tokenId?: string;
  /** Actor name for the action log: token name, "cli", "anonymous". */
  name: string;
}

/**
 * Why an MCP session ended. `disconnected`: the client's standalone SSE stream (GET /mcp) closed and
 * was not reopened within the grace period — how most clients (Claude Code included) end, since they
 * exit without sending DELETE.
 */
export type SessionEndReason = "deleted" | "timeout" | "disconnected" | "shutdown";

export interface SessionInfo {
  id: string;
  principal: Principal;
  clientName?: string;
  clientVersion?: string;
}

export interface DesktopRef {
  id: string;
  title: string | null;
  template: string;
  templateVersion: number;
  status: DesktopStatus | "removed";
  persistent: boolean;
  sessionIndex: number;
  screen: { width: number; height: number };
  mounts: Mount[];
  /** Memory/CPU caps and KVM (phase 6). */
  hardware?: DesktopHardware;
}

export interface ResolvedDesktop {
  desktop: DesktopRef;
  daemon: DaemonClient;
  /** What happened to the desktop since the session last used it (restarted, recreated, created). */
  notes: string[];
  /** The screen the agent last saw is gone: screen-dependent actions are not performed this call. */
  fresh: boolean;
}

export interface ActionRecord {
  desktopId: string;
  sessionId: string;
  actor: string;
  tool: string;
  args: unknown;
  summary: string;
  outcome: "ok" | "error" | "unknown";
  error?: { code: string; message: string } | null;
  durationMs: number;
  overlays: Overlay[];
  /** Image bytes (any format) to store with the entry. */
  screenshot?: Buffer | null;
}

export interface AgentImage {
  mimeType: "image/png" | "image/jpeg";
  /** base64 */
  data: string;
  width: number;
  height: number;
}

export interface StartOptions {
  mounts?: Mount[];
  template?: string;
  name?: string;
  persistent?: boolean;
  /** Phase 6: memory cap like "8g", CPU cap, /dev/kvm passthrough. */
  memory?: string;
  cpus?: number;
  kvm?: boolean;
}

export interface HumanWaitResult {
  outcome: "handed_back" | "dismissed" | "timeout" | "stopped";
  note: string | null;
  generation: number | null;
}

export interface McpBackend {
  readonly version: string;
  readonly instructions?: string;
  /** Per-desktop resource defaults/limits and KVM availability (phase 6), for descriptions. */
  hardware?(): HardwareInfo;
  /** Authenticates the Authorization header (null = 401). */
  authenticate(authorization: string | undefined): Principal | null;
  /** DNS-rebinding / cross-site protection: false = 403. */
  originAllowed(headers: Record<string, string | string[] | undefined>): boolean;
  /** True if a principal (by token id) may still use a session it opened (token not revoked). */
  principalActive(p: Principal): boolean;

  sessionOpened(info: SessionInfo): void;
  sessionTouched(sessionId: string): void;
  sessionClosed(sessionId: string, reason: SessionEndReason): Promise<void>;
  /** For resuming a session after a manager restart: the stored principal's token id, if the session is still open. */
  knownSession(sessionId: string): { tokenId: string | null; actor: string } | null;

  startDesktop(session: SessionInfo, opts: StartOptions): Promise<ResolvedDesktop>;
  stopDesktop(session: SessionInfo, desktopId?: string): Promise<{ desktop: DesktopRef; action: "removed" | "stopped" }>;
  listDesktops(session: SessionInfo): Promise<DesktopRef[]>;
  setTitle(session: SessionInfo, desktopId: string | undefined, title: string): Promise<DesktopRef>;
  /** Finds the session's desktop (default: its first), starting one lazily or restarting it as needed. */
  resolveDesktop(session: SessionInfo, desktopId?: string): Promise<ResolvedDesktop>;
  touchDesktop(desktopId: string): void;

  recordAction(rec: ActionRecord): void;
  /** Encodes a screenshot for the agent within the configured size budget (PNG, else JPEG). */
  encodeForAgent(image: Buffer): Promise<AgentImage>;

  listTemplates(): TemplateSummary[];
  templateInfo(name: string): TemplateDetail;
  /**
   * Saves the desktop as a new template version. description is required for a new template; for a
   * new version restate it or pass confirm_description to keep the previous one. notes: things the
   * agent should know (apps were closed, manifest caveats).
   */
  saveTemplate(
    session: SessionInfo,
    desktopId: string,
    input: { name: string; description?: TemplateDescription; confirm_description?: boolean; recipe?: string },
  ): Promise<TemplateSummary & { notes?: string[] }>;
  templateFeedback(session: SessionInfo, desktopId: string, kind: "ok" | "problem", note: string): Promise<{ template: string; version: number }>;
  /** Subscribe to template changes (for notifications/tools/list_changed). Returns an unsubscribe. */
  onTemplatesChanged(cb: () => void): () => void;

  filePut(session: SessionInfo, desktopId: string, hostPath: string, desktopPath: string): Promise<{ bytes: number }>;
  fileGet(session: SessionInfo, desktopId: string, desktopPath: string, hostPath: string): Promise<{ bytes: number }>;

  /** Flags the desktop for the human and waits for hand-back, dismissal or timeout. */
  requestHuman(
    session: SessionInfo,
    desktopId: string,
    reason: string,
    opts: { signal: AbortSignal; onProgress: (elapsedMs: number, totalMs: number) => void },
  ): Promise<HumanWaitResult>;
  clearAttention(desktopId: string): void;
}
