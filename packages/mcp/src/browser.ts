/**
 * `browser_*` tools: a curated set of Playwright MCP's tools, re-exported on deskhand's /mcp
 * (plan: "How browser tools plug in"). The tool list comes from the embedded Playwright MCP
 * (listed once at startup through an in-process client); calls are forwarded through a
 * BrowserProvider (the manager's per-desktop Playwright MCP connection, attached to the desktop's
 * own Chromium through the daemon's /cdp proxy).
 *
 * Every forwarded call goes through ToolRegistry like deskhand's own tools (desktop resolution,
 * generation/hand-back notes, unknown-outcome tracking, action log). The daemon does not gate CDP
 * traffic by the takeover lock, so the handler checks the lock itself before forwarding: it waits
 * for the user to hand back (like pixel input does in the daemon) and rejects the call with
 * control_changed if control changed meanwhile. The result goes back unchanged, plus any notes.
 */
import { z } from "zod";
import { DeskhandError } from "@deskhand/shared";
import type { ResolvedDesktop } from "./backend.js";
import { text, type Content, type JsonSchema, type ToolContext, type ToolRegistry } from "./registry.js";

/** A tool as listed by Playwright MCP. */
export interface UpstreamTool {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; [k: string]: unknown };
}

export interface BrowserCallResult {
  content: Content[];
  isError?: boolean;
  /** Notes for the agent from the provider (e.g. "Chromium was restarted; old refs are gone"). */
  notes?: string[];
}

export interface BrowserProvider {
  /**
   * Forwards one call to the desktop's Playwright MCP connection (created on first use, kept for the
   * desktop's lifetime, pointed at the visible tab). Throws DeskhandError: outcome_unknown when a
   * mutating call timed out or its connection dropped, timeout for read-only ones.
   */
  call(rd: ResolvedDesktop, tool: string, args: Record<string, unknown>, opts: { signal: AbortSignal; timeoutMs: number; mutating: boolean }): Promise<BrowserCallResult>;
}

export interface CuratedBrowserTool {
  /** Acts on elements/focus the agent saw before: not performed when control changed since (like clicks). */
  screenDependent: boolean;
  /** Only reads state: no action-log screenshot, a timeout is not an unknown outcome. */
  readOnly: boolean;
  /** Appended to Playwright's description. */
  note?: string;
}

/**
 * The re-exported set, from @playwright/mcp's default ("core") capabilities. Everything else is
 * excluded; see BROWSER_EXCLUDED for why. Upgrading @playwright/mcp must update this table and the
 * contract snapshot (packages/manager/test/__snapshots__/browser-contract.test.ts.snap) deliberately.
 */
export const BROWSER_TOOLS: Record<string, CuratedBrowserTool> = {
  browser_navigate: { screenDependent: false, readOnly: false, note: "file:// URLs open files inside the desktop." },
  browser_navigate_back: { screenDependent: false, readOnly: false },
  browser_snapshot: { screenDependent: false, readOnly: true, note: "Element refs from it stay valid across calls while the page is unchanged. Its boxes are page-viewport CSS pixels, not screenshot pixels." },
  browser_find: { screenDependent: false, readOnly: true },
  browser_click: { screenDependent: true, readOnly: false },
  browser_type: { screenDependent: true, readOnly: false },
  browser_fill_form: { screenDependent: true, readOnly: false },
  browser_select_option: { screenDependent: true, readOnly: false },
  browser_hover: { screenDependent: true, readOnly: false },
  browser_drag: { screenDependent: true, readOnly: false },
  browser_press_key: { screenDependent: true, readOnly: false },
  browser_handle_dialog: { screenDependent: false, readOnly: false },
  browser_file_upload: {
    screenDependent: false,
    readOnly: false,
    note: "`paths` are absolute paths of files inside the desktop (e.g. /home/agent/Downloads/report.pdf); copy host files in with file_put first.",
  },
  browser_wait_for: { screenDependent: false, readOnly: true },
  browser_tabs: { screenDependent: false, readOnly: false },
  browser_evaluate: { screenDependent: false, readOnly: false },
  browser_console_messages: { screenDependent: false, readOnly: true },
  browser_network_requests: { screenDependent: false, readOnly: true },
  browser_network_request: { screenDependent: false, readOnly: true },
};

/** Playwright MCP tools deskhand deliberately does not re-export, and why. */
export const BROWSER_EXCLUDED: Record<string, string> = {
  browser_close: "closes the shared browser the user is watching; agents never own the browser",
  browser_resize: "the window is maximised to the desktop; resizing it would desync screenshots and the user's view",
  browser_take_screenshot: "duplicates deskhand's screenshot/zoom (which show the whole desktop) and writes files on the manager",
  browser_install: "the desktop image ships Chromium; nothing to install (and it would run on the manager)",
  browser_run_code_unsafe: "runs arbitrary JavaScript in the manager process, which holds the Docker socket (root-equivalent on the host)",
  browser_emulate_media: "changes how pages render for the user watching the shared browser; rarely needed for tasks",
  browser_drop: "file paths would be read from the manager's filesystem; use browser_drag, left_click_drag or browser_file_upload instead",
  browser_pdf_save: "writes to the manager's filesystem, not the desktop's (print to PDF inside Chromium or use desktop_exec instead)",
};

/** Properties stripped from every forwarded schema: they name files on the manager's filesystem. */
export const STRIPPED_PROPS = ["filename"];

const DESKTOP_PROP = {
  type: "string",
  description: "Which desktop: an id from desktop_start or desktop_list. Defaults to this session's first desktop (started automatically if there is none).",
};

const CHANNEL_NOTE = " Acts on the desktop's own visible Chromium (the user can watch and take over).";

/** Builds deskhand's schema for a curated upstream tool: file-name properties removed, `desktop` added. */
export function browserSchema(t: UpstreamTool): JsonSchema {
  const s = structuredClone(t.inputSchema) as { properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown };
  const props: Record<string, unknown> = { ...(s.properties ?? {}) };
  for (const p of STRIPPED_PROPS) delete props[p];
  props.desktop = DESKTOP_PROP;
  const required = (s.required ?? []).filter((r) => !STRIPPED_PROPS.includes(r) && r !== "desktop");
  const out: JsonSchema = { ...s, type: "object", properties: props };
  if (required.length) out.required = required;
  else delete out.required;
  delete out.$schema;
  return out;
}

export function browserDescription(t: UpstreamTool, cur: CuratedBrowserTool): string {
  const base = (t.description ?? t.name).trim().replace(/\.?$/, ".");
  return base + CHANNEL_NOTE + (cur.note ? ` ${cur.note}` : "");
}

/** The curated subset of an upstream tool list, in deskhand's order. */
export function curateBrowserTools(upstream: UpstreamTool[]): Array<{ upstream: UpstreamTool; curated: CuratedBrowserTool }> {
  const byName = new Map(upstream.map((t) => [t.name, t]));
  const out: Array<{ upstream: UpstreamTool; curated: CuratedBrowserTool }> = [];
  for (const [name, curated] of Object.entries(BROWSER_TOOLS)) {
    const u = byName.get(name);
    if (u) out.push({ upstream: u, curated });
  }
  return out;
}

function short(v: unknown, n = 60): string {
  const s = String(v ?? "").replace(/\s+/g, " ");
  return JSON.stringify(s.length > n ? s.slice(0, n) + "…" : s);
}

/** Action-log summary for a browser call. */
export function summarizeBrowser(tool: string, a: Record<string, unknown>): string {
  const el = (e: unknown, t: unknown) => (e ? short(e, 50) : t ? String(t) : "");
  switch (tool) {
    case "browser_navigate":
      return `browser_navigate ${short(a.url, 100)}`;
    case "browser_click":
      return `browser_click ${el(a.element, a.target)}${a.doubleClick ? " (double)" : ""}`;
    case "browser_hover":
      return `browser_hover ${el(a.element, a.target)}`;
    case "browser_type":
      return `browser_type ${el(a.element, a.target)} ← ${short(a.text, 40)}${a.submit ? " ⏎" : ""}`;
    case "browser_fill_form": {
      const f = Array.isArray(a.fields) ? (a.fields as Array<{ name?: string }>) : [];
      return `browser_fill_form ${f.length} field${f.length === 1 ? "" : "s"}${f.length ? `: ${f.map((x) => x.name ?? "?").join(", ").slice(0, 80)}` : ""}`;
    }
    case "browser_select_option":
      return `browser_select_option ${el(a.element, a.target)} = ${short((a.values as unknown[] | undefined)?.join(", "), 40)}`;
    case "browser_drag":
      return `browser_drag ${el(a.startElement, a.startTarget)} → ${el(a.endElement, a.endTarget)}`;
    case "browser_press_key":
      return `browser_press_key ${String(a.key)}`;
    case "browser_tabs":
      return `browser_tabs ${String(a.action)}${a.index !== undefined ? ` ${String(a.index)}` : ""}${a.url ? ` ${short(a.url, 80)}` : ""}`;
    case "browser_wait_for":
      return `browser_wait_for ${a.text ? short(a.text, 40) : a.textGone ? `gone ${short(a.textGone, 40)}` : `${String(a.time)}s`}`;
    case "browser_handle_dialog":
      return `browser_handle_dialog ${a.accept ? "accept" : "dismiss"}`;
    case "browser_evaluate":
      return `browser_evaluate ${short(a.function, 60)}`;
    case "browser_find":
      return `browser_find ${short(a.text ?? a.regex, 50)}`;
    case "browser_file_upload":
      return `browser_file_upload ${Array.isArray(a.paths) ? (a.paths as string[]).join(", ").slice(0, 100) : "(cancel)"}`;
    default:
      return tool;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });
}

/**
 * The lock/generation gate for channels the daemon does not gate (CDP). Waits up to `waitMs` while the
 * user holds the lock, then fails with locked_by_user; if control changed since the generation the agent
 * last saw (the user took over and handed back meanwhile), fails with control_changed so the registry
 * shows the hand-back note and a fresh screenshot instead of acting on stale state.
 */
export async function waitForControl(ctx: ToolContext, waitMs: number, pollMs = 200): Promise<void> {
  const daemon = ctx.desktop!.daemon;
  const started = Date.now();
  let st = await daemon.state();
  let reported = false;
  while (st.lock) {
    if (ctx.signal.aborted) throw new DeskhandError("locked_by_user");
    if (Date.now() - started >= waitMs) throw new DeskhandError("locked_by_user");
    if (!reported) {
      ctx.progress(0, Math.round(waitMs / 1000), "The user is controlling this desktop; waiting for them to hand back");
      reported = true;
    }
    await sleep(pollMs, ctx.signal);
    st = await daemon.state();
  }
  if (st.generation !== ctx.generation) throw new DeskhandError("control_changed");
}

export interface BrowserToolOptions {
  /** How long a call waits while the user holds the lock (default 30 s, like pixel input). */
  lockWaitMs?: number;
  /** Deadline for one forwarded call (default 90 s; navigation alone may take 60 s). */
  callTimeoutMs?: number;
}

/** Registers the curated browser tools on the registry. Returns the registered names. */
export function registerBrowserTools(reg: ToolRegistry, upstream: UpstreamTool[], provider: BrowserProvider, opts: BrowserToolOptions = {}): string[] {
  const lockWaitMs = opts.lockWaitMs ?? 30_000;
  const callTimeoutMs = opts.callTimeoutMs ?? 90_000;
  const names: string[] = [];
  for (const { upstream: u, curated } of curateBrowserTools(upstream)) {
    const schema = browserSchema(u);
    const allowed = new Set(Object.keys((schema.properties as Record<string, unknown>) ?? {}).filter((k) => k !== "desktop"));
    const parse = z
      .record(z.string(), z.unknown())
      .superRefine((a, c) => {
        if (a.desktop !== undefined && (typeof a.desktop !== "string" || a.desktop.length < 1 || a.desktop.length > 64)) {
          c.addIssue({ code: "custom", path: ["desktop"], message: "desktop must be a desktop id string" });
        }
        for (const k of Object.keys(a)) {
          if (k !== "desktop" && !allowed.has(k)) c.addIssue({ code: "custom", path: [k], message: `unknown parameter ${k} for ${u.name}` });
        }
      });
    reg.register<Record<string, unknown>>({
      name: u.name,
      description: browserDescription(u, curated),
      inputSchema: schema,
      parse,
      scope: "desktop",
      input: true,
      screenDependent: curated.screenDependent,
      summarize: (a) => summarizeBrowser(u.name, a),
      async handler(args, ctx) {
        const rd = ctx.desktop!;
        await waitForControl(ctx, lockWaitMs);
        const { desktop: _d, ...forward } = args;
        const res = await provider.call(rd, u.name, forward, { signal: ctx.signal, timeoutMs: callTimeoutMs, mutating: !curated.readOnly });
        let shot: Buffer | null = null;
        if (!curated.readOnly) {
          shot = await rd.daemon
            .screenshot({ format: "png" })
            .then((s) => Buffer.from(s.data, "base64"))
            .catch(() => null);
        }
        const firstText = res.content.find((c) => c.type === "text") as { text: string } | undefined;
        return {
          content: [...(res.notes ?? []).map(text), ...res.content],
          logScreenshot: shot,
          ...(res.isError
            ? { isError: true, error: { code: "browser_error", message: (firstText?.text ?? "error").replace(/^###\s*Error\s*/i, "").slice(0, 300) } }
            : {}),
        };
      },
    });
    names.push(u.name);
  }
  return names;
}
