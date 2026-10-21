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
});
export type DesktopSummary = z.infer<typeof DesktopSummary>;

/** POST /api/desktops */
export const CreateDesktopRequest = z.object({
  template: z.string().optional(),
  name: z.string().optional(),
  mounts: z.array(Mount).optional(),
  persistent: z.boolean().optional(),
  screen: z.object({ width: z.number().int().min(640).max(1920), height: z.number().int().min(480).max(1080) }).optional(),
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
  session: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  overlays: z.array(Overlay),
  /** True if a screenshot is stored: GET /api/log/:id/screenshot (?thumb=1 for the thumbnail). */
  hasScreenshot: z.boolean(),
});
export type LogEntry = z.infer<typeof LogEntry>;

export const TemplateVersion = z.object({
  version: z.number().int(),
  image: z.string(),
  createdAt: z.string(),
  savedBy: z.string().nullable(), // token name / session / "dashboard"
  byAgent: z.boolean(),
  baseVersion: z.string(),
  hasRecipe: z.boolean(),
  description: z.lazy(() => TemplateDescription),
  loggedInSites: z.array(z.string()),
  extensions: z.array(z.string()),
  packages: z.array(z.string()),
  sizeBytes: z.number().nullable(),
  inUse: z.number().int(),
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
