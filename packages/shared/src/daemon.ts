/**
 * Contract for the control daemon's HTTP API (inside each desktop, port 7000,
 * reachable only on the internal Docker network). Every request carries
 * `Authorization: Bearer <daemon key>`; the manager generates one key per desktop.
 */
import { z } from "zod";

export const DAEMON_PORT = 7000;

export const Coordinate = z.tuple([z.number().int(), z.number().int()]);
export type Coordinate = z.infer<typeof Coordinate>;

/** `text` on clicks/scroll holds modifiers such as "ctrl+shift". */
const Modifiers = z.string().optional();

export const ClickAction = z.object({
  action: z.enum(["left_click", "right_click", "middle_click", "double_click", "triple_click"]),
  coordinate: Coordinate.optional(),
  text: Modifiers,
});
export const MouseMoveAction = z.object({ action: z.literal("mouse_move"), coordinate: Coordinate });
export const MouseDownAction = z.object({ action: z.literal("left_mouse_down") });
export const MouseUpAction = z.object({ action: z.literal("left_mouse_up") });
export const DragAction = z.object({
  action: z.literal("left_click_drag"),
  start_coordinate: Coordinate,
  coordinate: Coordinate,
  text: Modifiers,
  duration_ms: z.number().int().min(0).max(10_000).optional(), // default 400
  hold_ms: z.number().int().min(0).max(5_000).optional(), // default 150
});
export const ScrollAction = z.object({
  action: z.literal("scroll"),
  scroll_direction: z.enum(["up", "down", "left", "right"]),
  scroll_amount: z.number().int().min(0).max(100),
  coordinate: Coordinate.optional(),
  text: Modifiers,
});
export const TypeAction = z.object({ action: z.literal("type"), text: z.string() });
export const KeyAction = z.object({ action: z.literal("key"), text: z.string(), repeat: z.number().int().min(1).max(100).optional() });
/** duration in seconds */
export const HoldKeyAction = z.object({ action: z.literal("hold_key"), text: z.string(), duration: z.number().min(0).max(300) });
/** duration in seconds */
export const WaitAction = z.object({ action: z.literal("wait"), duration: z.number().min(0).max(300) });

export const InputAction = z.discriminatedUnion("action", [
  ClickAction,
  MouseMoveAction,
  MouseDownAction,
  MouseUpAction,
  DragAction,
  ScrollAction,
  TypeAction,
  KeyAction,
  HoldKeyAction,
  WaitAction,
]);
export type InputAction = z.infer<typeof InputAction>;

export const ImageFormat = z.enum(["png", "webp", "jpeg"]);
export type ImageFormat = z.infer<typeof ImageFormat>;

/** POST /input */
export const InputRequest = z.object({
  input: InputAction,
  /** Generation the caller last saw. If control changed since, the action is rejected with control_changed. */
  generation: z.number().int().optional(),
  /** Return a settled screenshot afterwards (default true). */
  screenshot: z.boolean().optional(),
  format: ImageFormat.optional(),
  /**
   * Hard deadline for the whole action in ms (default 10000). The daemon always allows at least the
   * action's own duration (hold_key/wait duration, drag duration_ms + hold_ms, typing time) + 10 s.
   */
  deadline_ms: z.number().int().positive().optional(),
  /**
   * Who sent it, recorded in the daemon log: e.g. "mcp:<session>" or "dashboard". A request whose actor
   * equals the lock holder is not blocked by that lock (the dashboard can send input while it holds it).
   */
  actor: z.string().optional(),
});
export type InputRequest = z.infer<typeof InputRequest>;

export const Screenshot = z.object({
  mime: z.string(), // image/png | image/webp | image/jpeg
  data: z.string(), // base64
  width: z.number().int(),
  height: z.number().int(),
});
export type Screenshot = z.infer<typeof Screenshot>;

export const InputResponse = z.object({
  ok: z.literal(true),
  generation: z.number().int(),
  cursor: Coordinate,
  screenshot: Screenshot.optional(),
  /** True if the screen was still changing when the settle cap was hit. */
  unsettled: z.boolean().optional(),
  /** Daemon notes for the agent (e.g. a stuck button was released). */
  notes: z.array(z.string()).optional(),
});
export type InputResponse = z.infer<typeof InputResponse>;

/** GET /screenshot?format=png|webp|jpeg&scale=0.25&quality=80 -> InputResponse-like Screenshot JSON when Accept: application/json, else raw image bytes. */
export const ScreenshotQuery = z.object({
  format: ImageFormat.optional(),
  /** 0 < scale <= 1; thumbnails use a small scale. Coordinates are never scaled for agents. */
  scale: z.coerce.number().positive().max(1).optional(),
  quality: z.coerce.number().int().min(1).max(100).optional(),
  /**
   * Zoom region "x0,y0,x1,y1" in screen pixels. Captured at full resolution, then scaled (up or down) to fit
   * within the screen size with aspect ratio preserved — matching computer_toolset_20260801's `zoom`.
   */
  region: z.string().optional(),
});

export const Lock = z.object({
  holder: z.string(),
  since: z.string(), // ISO time
  generation: z.number().int(),
});
export type Lock = z.infer<typeof Lock>;

export const Handback = z.object({
  note: z.string().nullable(),
  at: z.string(),
  generation: z.number().int(),
});
export type Handback = z.infer<typeof Handback>;

/** GET /state */
export const DaemonState = z.object({
  version: z.string(),
  apiVersion: z.number().int(),
  title: z.string().nullable(), // active window title
  screen: z.object({ width: z.number().int(), height: z.number().int() }),
  lock: Lock.nullable(),
  generation: z.number().int(),
  lastHandback: Handback.nullable(),
  lastAction: z.object({ action: z.string(), at: z.string(), actor: z.string().nullable() }).nullable(),
  uptimeSec: z.number(),
  heldButtons: z.array(z.number().int()),
  cdpAvailable: z.boolean(),
  /** Whether Chromium last started with its sandbox ("off" = --no-sandbox fallback), null if not started yet. */
  chromiumSandbox: z.enum(["on", "off"]).nullable().optional(),
  /** Input actions waiting in the per-desktop queue. */
  queueLength: z.number().int().optional(),
});
export type DaemonState = z.infer<typeof DaemonState>;

/** GET /cursor */
export const CursorResponse = z.object({ x: z.number().int(), y: z.number().int(), cursor: Coordinate });
export type CursorResponse = z.infer<typeof CursorResponse>;

/**
 * POST /release-all — release every mouse button and key the daemon holds. The manager calls it on
 * desktop_stop and MCP session end (takeover and the ~30 s stuck-button timer do it automatically).
 */
export const ReleaseAllResponse = z.object({ released: z.array(z.string()) });
export type ReleaseAllResponse = z.infer<typeof ReleaseAllResponse>;

/** PUT /files response. */
export const FilePutResponse = z.object({ bytes: z.number().int() });

/** POST /quiesce response. */
export const QuiesceResponse = z.object({
  ok: z.literal(true),
  chromiumClosed: z.boolean(),
  closedWindows: z.number().int(),
  killed: z.array(z.string()),
  cleared: z.array(z.string()),
  notes: z.array(z.string()),
});
export type QuiesceResponse = z.infer<typeof QuiesceResponse>;

/** POST /lock */
export const LockRequest = z.object({ holder: z.string() });
/** DELETE /lock (body optional) */
export const UnlockRequest = z.object({ note: z.string().nullable().optional() });
export const LockResponse = z.object({ generation: z.number().int(), lock: Lock.nullable() });

/** POST /exec — runs as the `agent` user with stdin closed; kills the process group on timeout. */
export const ExecRequest = z.object({
  command: z.string(),
  timeout_ms: z.number().int().positive().max(600_000).optional(), // default 60000
  cwd: z.string().optional(),
  generation: z.number().int().optional(),
  actor: z.string().optional(),
});
export const ExecResponse = z.object({
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
});
export type ExecResponse = z.infer<typeof ExecResponse>;

/** GET /files?path=/abs/path -> raw bytes. PUT /files?path=/abs/path (raw body) -> {bytes}. Owned by `agent`. */

/** GET /ui-tree?window=<title substring> */
export const UiNode: z.ZodType<UiNodeT> = z.lazy(() =>
  z.object({
    role: z.string(),
    name: z.string(),
    states: z.array(z.string()).optional(),
    box: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(), // x, y, w, h in screen px
    /** On top-level windows: the application's name (e.g. "Chromium", "mousepad"). */
    app: z.string().optional(),
    children: z.array(UiNode).optional(),
  }),
);
export interface UiNodeT {
  role: string;
  name: string;
  states?: string[];
  box?: [number, number, number, number];
  app?: string;
  children?: UiNodeT[];
}

/**
 * GET /cdp/json/version and websocket /cdp/devtools/... proxy Chromium's
 * remote-debugging port (localhost-only inside the container). The daemon
 * rewrites webSocketDebuggerUrl to point back through itself: ws://<Host>/cdp/...,
 * or, behind a proxy, ws[s]://<X-Forwarded-Host><X-Forwarded-Prefix>/cdp/...
 * (wss when X-Forwarded-Proto is https). Chromium is launched on demand.
 * The daemon does not gate CDP messages by the lock; callers (the manager) check
 * /state's lock and generation before forwarding browser tool calls.
 *
 * POST /quiesce — close Chromium via CDP (flushes cookies), close other apps,
 * clear caches, ~/Downloads and /tmp. Used before `docker commit`.
 *
 * GET /vnc?mode=view|control&generation=N — websocket carrying raw RFB.
 * The daemon filters client->server input messages (key, pointer, clipboard)
 * unless mode=control AND the desktop is locked AND generation matches the
 * current one. Connections from an old generation are closed.
 *
 * GET /health -> { ok, version, apiVersion }
 */
export const Health = z.object({ ok: z.boolean(), version: z.string(), apiVersion: z.number().int() });
