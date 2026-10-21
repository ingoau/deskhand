/**
 * Contract for the manager's HTTP API, used by the dashboard and the CLI.
 * Every path is under DESKHAND_BASE_PATH (default ""), e.g. `${base}/api/desktops`.
 * Auth: session cookie (dashboard) or `Authorization: Bearer <api token>`.
 * Errors use ErrorBody from ./errors.
 */
import { z } from "zod";
import { Coordinate, Handback, Lock } from "./daemon.js";

export const DEFAULT_PORT = 7480;

export const Mount = z.object({
  /** Absolute host path; mounted at the same path inside the desktop. */
  path: z.string().startsWith("/"),
  /** Read-only unless true. */
  write: z.boolean().optional(),
});
export type Mount = z.infer<typeof Mount>;

export const DesktopStatus = z.enum(["starting", "running", "stopped", "removing", "error"]);
export type DesktopStatus = z.infer<typeof DesktopStatus>;

export const Attention = z.object({
  reason: z.string(),
  since: z.string(),
  /** When request_human gives up waiting (ISO), if known. */
  timeoutAt: z.string().nullable(),
});
export type Attention = z.infer<typeof Attention>;

export const LastAction = z.object({
  tool: z.string(),
  /** Short human-readable form, e.g. `left_click [812, 344]`. */
  summary: z.string(),
  at: z.string(),
});
export type LastAction = z.infer<typeof LastAction>;

/** The resources a desktop runs with (phase 6, opt-in hardware). */
export const DesktopHardware = z.object({
  /** Memory cap in bytes. */
  memoryBytes: z.number().int(),
  /** CPU cap (cores, may be fractional). */
  cpus: z.number(),
  /** /dev/kvm is passed into the desktop (usable by the agent user). */
  kvm: z.boolean(),
});
export type DesktopHardware = z.infer<typeof DesktopHardware>;

/**
 * Hardware a template version records from the desktop it was saved from. Desktops started from
 * the template default to it (explicit arguments override). memoryBytes/cpus are null when the
 * desktop ran with the manager's defaults (so it follows the defaults later).
 */
export const TemplateHardware = z.object({
  kvm: z.boolean(),
  memoryBytes: z.number().int().nullable(),
  cpus: z.number().nullable(),
});
export type TemplateHardware = z.infer<typeof TemplateHardware>;

/** Per-desktop resource defaults and limits of this manager (GET /api/system `hardware`). */
export const HardwareInfo = z.object({
  defaultMemoryBytes: z.number().int(),
  defaultCpus: z.number(),
  /** DESKHAND_DESKTOP_MAX_MEMORY / DESKHAND_DESKTOP_MAX_CPUS. */
  maxMemoryBytes: z.number().int(),
  maxCpus: z.number(),
  /**
   * available: the Docker host has /dev/kvm and DESKHAND_KVM=auto; unavailable: no /dev/kvm;
   * disabled: DESKHAND_KVM=off; unknown: not detected yet (the Docker engine was unreachable).
   */
  kvm: z.enum(["available", "unavailable", "disabled", "unknown"]),
});
export type HardwareInfo = z.infer<typeof HardwareInfo>;

export const DesktopSummary = z.object({
  id: z.string(),
  /** Container name, e.g. deskhand-7f3a. */
  name: z.string(),
  /** Set by the agent with set_title, or the name given to desktop_start. */
  title: z.string().nullable(),
  /** Session display label, e.g. `claude-laptop/9f2c` (token name / short session id). */
  session: z.string().nullable(),
  /** Index of this desktop within its session (0 = the session's first desktop). */
  sessionIndex: z.number().int(),
  template: z.string(),
  templateVersion: z.number().int(),
  status: DesktopStatus,
  persistent: z.boolean(),
  attention: Attention.nullable(),
  lock: Lock.nullable(),
  generation: z.number().int(),
  lastHandback: Handback.nullable(),
  lastAction: LastAction.nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  stoppedAt: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
  screen: z.object({ width: z.number().int(), height: z.number().int() }),
  mounts: z.array(Mount),
  /** Live usage; null when stopped. */
  cpuPercent: z.number().nullable(),
  memoryBytes: z.number().nullable(),
  diskBytes: z.number().nullable(),
  /** Phase 6: memory/CPU caps and KVM (optional so older clients and mocks keep working). */
  hardware: DesktopHardware.optional(),
});
export type DesktopSummary = z.infer<typeof DesktopSummary>;

/** POST /api/desktops */
export const CreateDesktopRequest = z.object({
  template: z.string().optional(),
  name: z.string().optional(),
  mounts: z.array(Mount).optional(),
  persistent: z.boolean().optional(),
  screen: z.object({ width: z.number().int().min(640).max(1920), height: z.number().int().min(480).max(1080) }).optional(),
  // ---- phase 6 (opt-in hardware). Omitted = the template's recorded hardware, else the defaults.
  /** Memory cap, e.g. "8g" or "4096m" (or bytes as a number); at most DESKHAND_DESKTOP_MAX_MEMORY. */
  memory: z.union([z.string().min(1).max(32), z.number().int().positive()]).optional(),
  /** CPU cap in cores, e.g. 4 or 2.5; at most DESKHAND_DESKTOP_MAX_CPUS. */
  cpus: z.number().positive().optional(),
  /** Pass /dev/kvm into the desktop (for emulators and other VMs); kvm_unavailable if the host has none. */
  kvm: z.boolean().optional(),
});
export type CreateDesktopRequest = z.infer<typeof CreateDesktopRequest>;

/** GET /api/system */
export const SystemSummary = z.object({
  version: z.string(),
  running: z.number().int(),
  maxDesktops: z.number().int(),
  /** Host CPU used by running desktops, percent of all host cores. */
  cpuPercent: z.number(),
  memoryUsedBytes: z.number(),
  memoryBudgetBytes: z.number(),
  logDiskBytes: z.number(),
  auth: z.boolean(),
  /** Phase 6: per-desktop resource defaults/limits and KVM availability. */
  hardware: HardwareInfo.optional(),
});
export type SystemSummary = z.infer<typeof SystemSummary>;

/** Marks drawn on a log entry's screenshot. */
export const Overlay = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("point"), at: Coordinate, label: z.string().optional() }),
  z.object({ kind: z.literal("path"), points: z.array(Coordinate) }),
  z.object({ kind: z.literal("region"), region: z.tuple([z.number(), z.number(), z.number(), z.number()]) }),
]);
export type Overlay = z.infer<typeof Overlay>;

/** GET /api/desktops/:id/log?before=<id>&limit=50 -> { entries: LogEntry[] } newest first */
export const LogEntry = z.object({
  id: z.number().int(),
  desktopId: z.string(),
  at: z.string(),
  /** Tool or channel: `left_click`, `browser_click`, `desktop_exec`, `takeover`, `handback`, `request_human`... */
  tool: z.string(),
  args: z.unknown(),
  summary: z.string(),
  outcome: z.enum(["ok", "error", "unknown"]),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  /** Token name or "dashboard". */
  actor: z.string().nullable(),
  /** Session label like DesktopSummary.session (`claude-laptop/9f2c`); null for dashboard actions. */
  session: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  overlays: z.array(Overlay),
  /** True if a screenshot is stored: GET /api/log/:id/screenshot (?thumb=1 for the thumbnail). */
  hasScreenshot: z.boolean(),
});
export type LogEntry = z.infer<typeof LogEntry>;

/** What changed in a version compared with the previous one still kept (computed by the manager). */
export const TemplateListChange = z.object({ added: z.array(z.string()), removed: z.array(z.string()) });
export type TemplateListChange = z.infer<typeof TemplateListChange>;
export const TemplateChanges = z.object({
  /** The version compared against (null for the first version). */
  from: z.number().int().nullable(),
  /** Description fields whose value changed. */
  description: z.array(z.object({ field: z.string(), before: z.unknown(), after: z.unknown() })),
  loggedInSites: TemplateListChange,
  extensions: TemplateListChange,
  packages: TemplateListChange,
  recipeChanged: z.boolean(),
  baseChanged: z.boolean(),
});
export type TemplateChanges = z.infer<typeof TemplateChanges>;

export const TemplateVersion = z.object({
  version: z.number().int(),
  image: z.string(),
  createdAt: z.string(),
  savedBy: z.string().nullable(), // token name / session / "dashboard"
  byAgent: z.boolean(),
  baseVersion: z.string(),
  hasRecipe: z.boolean(),
  description: z.lazy(() => TemplateDescription),
  /** Registrable domains with persistent login-like cookies (Chromium and Firefox). Cookie values are never read. */
  loggedInSites: z.array(z.string()),
  /** Browser extensions installed in the profile, e.g. "Refined GitHub 24.10.1" (Firefox ones are prefixed "Firefox: "). */
  extensions: z.array(z.string()),
  /** Debian packages added compared with the base image, e.g. "jq 1.7.1+dfsg-1". */
  packages: z.array(z.string()),
  sizeBytes: z.number().nullable(),
  inUse: z.number().int(),
  // ---- phase 4 additions (optional so older clients and mocks keep working)
  /** Session label of the MCP session (or "dashboard") that saved it, and the desktop it came from. */
  savedFrom: z.object({ desktop: z.string(), title: z.string().nullable(), session: z.string().nullable() }).nullable().optional(),
  /** Set when this version was produced by replaying the recipe on a new base image. */
  rebuiltFrom: z.number().int().nullable().optional(),
  /** Notes from computing the manifest (e.g. "base package list not found"). */
  manifestNotes: z.array(z.string()).optional(),
  /** The recipe stored with this version (the current one is also TemplateDetail.recipe). */
  recipe: z.string().nullable().optional(),
  /** Diff against the previous kept version. */
  changes: TemplateChanges.optional(),
  /** Phase 6: hardware recorded from the desktop this version was saved from (null for older versions). */
  hardware: TemplateHardware.nullable().optional(),
});
export type TemplateVersion = z.infer<typeof TemplateVersion>;

export const TemplateDescription = z.object({
  summary: z.string().min(1),
  use_when: z.string().min(1),
  not_for: z.string().optional(),
  setup_notes: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
export type TemplateDescription = z.infer<typeof TemplateDescription>;

export const TemplateFeedback = z.object({
  at: z.string(),
  kind: z.enum(["ok", "problem"]),
  note: z.string(),
  by: z.string().nullable(),
  version: z.number().int(),
  /** Session label of the reporting agent (phase 4). */
  session: z.string().nullable().optional(),
});
export type TemplateFeedback = z.infer<typeof TemplateFeedback>;

/** GET /api/templates -> { templates: TemplateSummary[] } */
export const TemplateSummary = z.object({
  name: z.string(),
  currentVersion: z.number().int(),
  latestVersion: z.number().int(),
  description: TemplateDescription,
  loggedInSites: z.array(z.string()),
  updatedAt: z.string(),
  /** Changed by an agent in the last 24h. */
  recentlyChangedByAgent: z.boolean(),
  lastFeedback: TemplateFeedback.nullable(),
  lastConfirmedAt: z.string().nullable(),
  stale: z.boolean(),
  outdatedBase: z.boolean(),
  isDefault: z.boolean(),
  // ---- phase 4 additions (optional so older clients and mocks keep working)
  /** Why the template is stale: "problem reported: …" or "not confirmed in 14 days". */
  staleReason: z.string().nullable().optional(),
  /** When an agent last saved a version (drives recentlyChangedByAgent, 24 h). */
  changedByAgentAt: z.string().nullable().optional(),
  hasRecipe: z.boolean().optional(),
  /** Base image version the current version was built on, and the base the manager runs now. */
  baseVersion: z.string().optional(),
  currentBaseVersion: z.string().optional(),
  extensions: z.array(z.string()).optional(),
  /** Recipe replay on a new base image: last attempt. */
  rebuild: z
    .object({
      status: z.enum(["queued", "running", "ok", "failed"]),
      at: z.string(),
      baseVersion: z.string(),
      error: z.string().nullable(),
      version: z.number().int().nullable(),
    })
    .nullable()
    .optional(),
  /** Phase 6: the current version's recorded hardware (desktops started from it default to this). */
  hardware: TemplateHardware.nullable().optional(),
});
export type TemplateSummary = z.infer<typeof TemplateSummary>;

/** GET /api/templates/:name */
export const TemplateDetail = TemplateSummary.extend({
  versions: z.array(TemplateVersion),
  feedback: z.array(TemplateFeedback),
  recipe: z.string().nullable(),
});
export type TemplateDetail = z.infer<typeof TemplateDetail>;

export const ApiToken = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export type ApiToken = z.infer<typeof ApiToken>;
