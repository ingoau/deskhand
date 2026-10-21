/**
 * Tool registry. Every tool call goes through ToolRegistry.call, which does — in one place —
 * argument validation, desktop resolution (lazy start / restart), lock and generation checks,
 * hand-back and other note delivery, unknown-outcome tracking, action logging and error mapping.
 *
 * Extension point: phase 3 registers `browser_*` tools (forwarded from @playwright/mcp through
 * the daemon's CDP proxy) with `registry.register({ ..., scope: "desktop", input: true })`; they
 * get the `desktop` argument, lock/generation handling, logging and notes for free.
 */
import type { z } from "zod";
import { DeskhandError, ERROR_MESSAGES, type DaemonState, type Overlay } from "@deskhand/shared";
import type { McpBackend, ResolvedDesktop, SessionInfo } from "./backend.js";

export type JsonSchema = Record<string, unknown>;

export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface CallToolResult {
  content: Content[];
  isError?: boolean;
  [k: string]: unknown;
}

/** Per-session bookkeeping: last generation delivered per desktop, notes owed to the agent. */
export class SessionState {
  readonly seen = new Map<string, number>();
  private readonly pending = new Map<string, { notes: string[]; shot: boolean }>();

  addPending(desktopId: string, note: string, shot = false) {
    const p = this.pending.get(desktopId) ?? { notes: [], shot: false };
    if (!p.notes.includes(note)) p.notes.push(note);
    p.shot ||= shot;
    this.pending.set(desktopId, p);
  }

  takePending(desktopId: string): { notes: string[]; shot: boolean } {
    const p = this.pending.get(desktopId) ?? { notes: [], shot: false };
    this.pending.delete(desktopId);
    return p;
  }
}

export interface ToolContext {
  session: SessionInfo;
  state: SessionState;
  backend: McpBackend;
  registry: ToolRegistry;
  signal: AbortSignal;
  /** MCP progress notification, if the client sent a progressToken. */
  progress(progress: number, total?: number, message?: string): void;
  /** Set for desktop-scoped tools. */
  desktop?: ResolvedDesktop;
  /** Generation the agent last saw; pass to input calls. */
  generation: number;
  markSeen(generation: number): void;
  actor: string;
  /** Number of desktops this session has (for "which desktop" hints). */
}

export interface ToolOutput {
  content: Content[];
  /** Short log summary; defaults to summarize(tool, args). */
  summary?: string;
  overlays?: Overlay[];
  /** Image bytes stored with the log entry. */
  logScreenshot?: Buffer | null;
  /** Lifecycle tools that choose their desktop themselves report it here, for logging. */
  desktopId?: string;
  isError?: boolean;
  error?: { code: string; message: string };
  /** Don't write an action-log entry. */
  skipLog?: boolean;
  /** The result already carries a screenshot. */
  hasScreenshot?: boolean;
}

export interface ToolDef<A = Record<string, unknown>> {
  name: string;
  description: string | (() => string);
  inputSchema: JsonSchema;
  parse: z.ZodType<A>;
  /** "desktop": the wrapper resolves (and lazily starts) the target desktop before the handler runs. */
  scope: "session" | "desktop";
  /** Blocked by the takeover lock; carries the generation. */
  input?: boolean;
  /** Acts on screen positions/content: not performed when the screen the agent last saw is gone. */
  screenDependent?: boolean;
  handler(args: A, ctx: ToolContext): Promise<ToolOutput>;
  summarize?(args: A): string;
}

export const LOCK_NOTE = "The user is controlling this desktop right now; input tools will wait for them to hand back. Screenshots still work.";
export const UNKNOWN_NOTE = "Your previous action on this desktop may or may not have happened (it timed out or its connection dropped) and was not retried. Check the screenshot before continuing.";

export function handbackNote(st: DaemonState, seen: number): string {
  const hb = st.lastHandback;
  if (hb && hb.generation > seen) {
    return hb.note && hb.note.trim() ? `The user handed control back: ${hb.note.trim()}` : "The user handed control back (no note). The screen may have changed.";
  }
  return "Control of this desktop changed since your last action; the screen may have changed.";
}

export function text(t: string): Content {
  return { type: "text", text: t };
}

export function errorResult(code: string, message: string, notes: string[] = []): CallToolResult {
  return { content: [...notes.map(text), text(`Error (${code}): ${message}`)], isError: true };
}

function zodMessage(e: unknown): string {
  const issues = (e as { issues?: Array<{ path: PropertyKey[]; message: string }> })?.issues;
  if (!issues?.length) return ERROR_MESSAGES.invalid_argument;
  return issues
    .slice(0, 5)
    .map((i) => `${i.path.length ? i.path.map(String).join(".") + ": " : ""}${i.message}`)
    .join("; ");
}

export type Summarizer = (tool: string, args: Record<string, unknown>) => string;

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef<any>>();

  constructor(
    private readonly backend: McpBackend,
    private readonly summarize: Summarizer,
  ) {}

  register<A>(def: ToolDef<A>): void {
    if (this.tools.has(def.name)) throw new Error(`duplicate tool ${def.name}`);
    this.tools.set(def.name, def as ToolDef<any>);
  }

  get(name: string): ToolDef<any> | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  list(): Array<{ name: string; description: string; inputSchema: JsonSchema }> {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: typeof t.description === "function" ? t.description() : t.description,
      inputSchema: t.inputSchema,
    }));
  }

  private async freshScreenshot(rd: ResolvedDesktop): Promise<{ content: Content[]; raw: Buffer | null }> {
    try {
      const shot = await rd.daemon.screenshot({ format: "png" });
      const raw = Buffer.from(shot.data, "base64");
      const img = await this.backend.encodeForAgent(raw);
      return { content: [{ type: "image", data: img.data, mimeType: img.mimeType }], raw };
    } catch {
      return { content: [text("(Could not capture a screenshot.)")], raw: null };
    }
  }

  async call(
    name: string,
    rawArgs: unknown,
    base: { session: SessionInfo; state: SessionState; signal: AbortSignal; progress: ToolContext["progress"] },
  ): Promise<CallToolResult> {
    const def = this.tools.get(name);
    if (!def) return errorResult("invalid_argument", `Unknown tool ${name}.`);
    const t0 = Date.now();
    const parsed = def.parse.safeParse(rawArgs ?? {});
    if (!parsed.success) return errorResult("invalid_argument", zodMessage(parsed.error));
    const args = parsed.data as Record<string, unknown>;
    const summary = def.summarize ? def.summarize(args) : this.summarize(name, args);
    const { session, state } = base;
    const actor = session.principal.name;
    this.backend.sessionTouched(session.id);

    const ctx: ToolContext = {
      ...base,
      backend: this.backend,
      registry: this,
      generation: 0,
      markSeen: () => undefined,
      actor,
    };

    const log = (desktopId: string | undefined, out: Partial<ToolOutput> & { outcome: "ok" | "error" | "unknown" }) => {
      if (!desktopId || out.skipLog) return;
      this.backend.recordAction({
        desktopId,
        sessionId: session.id,
        actor,
        tool: name,
        args,
        summary: out.summary ?? summary,
        outcome: out.outcome,
        error: out.error ?? null,
        durationMs: Date.now() - t0,
        overlays: out.overlays ?? [],
        screenshot: out.logScreenshot ?? null,
      });
    };

    if (def.scope === "session") {
      try {
        const out = await def.handler(args, ctx);
        log(out.desktopId, { ...out, outcome: out.isError ? "error" : "ok" });
        if (out.desktopId) this.backend.touchDesktop(out.desktopId);
        return { content: out.content, ...(out.isError ? { isError: true } : {}) };
      } catch (e) {
        return this.fail(e, []);
      }
    }

    // ---- desktop-scoped tools
    let rd: ResolvedDesktop;
    try {
      rd = await this.backend.resolveDesktop(session, args.desktop as string | undefined);
    } catch (e) {
      return this.fail(e, []);
    }
    const did = rd.desktop.id;
    const notes = [...rd.notes];
    const pend = state.takePending(did);
    notes.push(...pend.notes);
    let needShot = pend.shot;

    let st: DaemonState;
    try {
      st = await rd.daemon.state();
    } catch (e) {
      return this.fail(e, notes);
    }
    let seen = state.seen.get(did);
    let screenGone = rd.fresh;
    if (rd.fresh || seen === undefined || st.generation < seen) {
      // New or restarted desktop (or a restarted daemon): start tracking from here.
      seen = st.generation;
      state.seen.set(did, seen);
    } else if (st.generation !== seen && !st.lock) {
      notes.push(handbackNote(st, seen));
      seen = st.generation;
      state.seen.set(did, seen);
      screenGone = true;
    }
    if (st.lock && !def.input) notes.push(LOCK_NOTE);
    if (screenGone && !rd.fresh) needShot = true;
    if (rd.fresh) needShot = true;

    if (screenGone && def.screenDependent) {
      const shot = await this.freshScreenshot(rd);
      const msg = `Your ${name} was not performed because the screen changed since you last saw it. Look at this screenshot and decide again.`;
      log(did, { outcome: "error", error: { code: "control_changed", message: msg }, logScreenshot: shot.raw });
      this.backend.touchDesktop(did);
      return { content: [...notes.map(text), text(msg), ...shot.content] };
    }
    if (def.input && name !== "request_human") this.backend.clearAttention(did);

    ctx.desktop = rd;
    ctx.generation = seen;
    ctx.markSeen = (g: number) => {
      state.seen.set(did, g);
      ctx.generation = g;
    };

    try {
      const out = await def.handler(args, ctx);
      log(did, { ...out, outcome: out.isError ? "error" : "ok" });
      this.backend.touchDesktop(did);
      const content = [...notes.map(text), ...out.content];
      if (needShot && !out.hasScreenshot) content.push(...(await this.freshScreenshot(rd)).content);
      return { content, ...(out.isError ? { isError: true } : {}) };
    } catch (e) {
      this.backend.touchDesktop(did);
      const err = e instanceof DeskhandError ? e : null;
      if (err?.code === "control_changed") {
        // Control changed while the action waited in the daemon's queue (e.g. the user took over and handed back).
        const st2 = await rd.daemon.state().catch(() => null);
        if (st2) {
          notes.push(handbackNote(st2, seen));
          state.seen.set(did, st2.generation);
        }
        const shot = await this.freshScreenshot(rd);
        const msg = `Your ${name} was not performed because control of the desktop changed while it waited. Look at this screenshot and decide again.`;
        log(did, { outcome: "error", error: { code: "control_changed", message: msg }, logScreenshot: shot.raw });
        return { content: [...notes.map(text), text(msg), ...shot.content] };
      }
      if (err?.code === "outcome_unknown") {
        state.addPending(did, UNKNOWN_NOTE, true);
        log(did, { outcome: "unknown", error: { code: err.code, message: err.message } });
        return errorResult(err.code, err.message, notes);
      }
      const code = err?.code ?? "internal";
      const message = err?.message ?? ERROR_MESSAGES.internal;
      log(did, { outcome: "error", error: { code, message } });
      return errorResult(code, message, notes);
    }
  }

  private fail(e: unknown, notes: string[]): CallToolResult {
    if (e instanceof DeskhandError) return errorResult(e.code, e.message, notes);
    return errorResult("internal", ERROR_MESSAGES.internal, notes);
  }
}
