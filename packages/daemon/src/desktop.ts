/**
 * The desktop: X connection (reconnecting), input engine, capture/settle, and the input pipeline
 * (queue → lock/generation → deadline → action → settle → screenshot).
 */
import { readFileSync } from "node:fs";
import { DeskhandError, type InputRequest, type InputResponse, type Screenshot } from "@deskhand/shared";
import { Control } from "./control.js";
import { expectedDurationMs, InputEngine } from "./input.js";
import { log } from "./log.js";
import { encodeFrame, type EncodeOptions } from "./screenshot.js";
import { waitForSettle } from "./settle.js";
import { sleep, withDeadline } from "./util.js";
import { XConn, type Frame } from "./xconn.js";

export const DEFAULT_DEADLINE_MS = 10_000;
/** Margin added to long actions' own duration (hold_key, wait, long drags/typing). */
export const DEADLINE_MARGIN_MS = 10_000;

export interface LastAction {
  action: string;
  at: string;
  actor: string | null;
}

export class Desktop {
  readonly control: Control;
  private conn: XConn | null = null;
  private engine: InputEngine | null = null;
  private connecting: Promise<XConn> | null = null;
  lastAction: LastAction | null = null;
  readonly startedAt = Date.now();
  /** Recent actions (in-memory ring) for debugging via /state consumers and logs. */
  readonly recent: { action: string; at: string; actor: string | null; ms: number; outcome: string }[] = [];

  constructor(opts: { lockWaitMs?: number; stuckButtonMs?: number } = {}) {
    this.control = new Control({ lockWaitMs: opts.lockWaitMs });
    this.stuckButtonMs = opts.stuckButtonMs;
    // Takeover and hand-back release anything the agent left pressed.
    this.control.on("change", () => {
      if (this.engine) {
        const released = this.engine.releaseAllSync();
        if (released.length) {
          this.engine.addNote(`Released ${released.join(", ")} when control changed.`);
          log.info("released held input on control change", { released });
        }
      }
    });
  }
  private readonly stuckButtonMs?: number;

  /** Connect (or reconnect) to the X server, retrying until `timeoutMs`. */
  async x(timeoutMs = 5000): Promise<XConn> {
    if (this.conn && !this.conn.dead) return this.conn;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const start = Date.now();
      let lastErr: unknown;
      while (Date.now() - start < timeoutMs) {
        try {
          const c = await XConn.connect();
          this.conn = c;
          this.engine = new InputEngine(c, { stuckButtonMs: this.stuckButtonMs });
          await this.engine.keyboard.load();
          log.info("connected to X", { width: c.width, height: c.height });
          return c;
        } catch (e) {
          lastErr = e;
          await sleep(250);
        }
      }
      throw new DeskhandError("daemon_unavailable", `The desktop's display is not available (${String((lastErr as Error)?.message ?? lastErr)}).`);
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async input(): Promise<InputEngine> {
    await this.x();
    return this.engine!;
  }

  get screen(): { width: number; height: number } {
    if (this.conn) return { width: this.conn.width, height: this.conn.height };
    try {
      const env = readFileSync("/run/deskhand/screen.env", "utf8");
      const w = Number(/DESKHAND_SCREEN_W=(\d+)/.exec(env)?.[1]);
      const h = Number(/DESKHAND_SCREEN_H=(\d+)/.exec(env)?.[1]);
      if (w && h) return { width: w, height: h };
    } catch {
      /* not in the image */
    }
    return { width: 1280, height: 800 };
  }

  async capture(): Promise<Frame> {
    const c = await this.x();
    return c.capture();
  }

  async screenshot(opts: EncodeOptions = {}): Promise<Screenshot> {
    const frame = await this.capture();
    const e = await encodeFrame(frame, opts);
    return { mime: e.mime, data: e.data.toString("base64"), width: e.width, height: e.height };
  }

  heldButtons(): number[] {
    return this.engine ? [...this.engine.heldButtons] : [];
  }

  private record(action: string, actor: string | null, ms: number, outcome: string): void {
    const at = new Date().toISOString();
    this.lastAction = { action, at, actor };
    this.recent.push({ action, at, actor, ms: Math.round(ms), outcome });
    if (this.recent.length > 100) this.recent.shift();
  }

  /** POST /input */
  async perform(req: InputRequest): Promise<InputResponse> {
    const a = req.input;
    const actor = req.actor ?? null;
    const deadline = Math.max(req.deadline_ms ?? DEFAULT_DEADLINE_MS, expectedDurationMs(a) + DEADLINE_MARGIN_MS);
    const t0 = performance.now();
    let outcome = "ok";
    try {
      return await this.control.run({ generation: req.generation, actor: req.actor }, ({ signal }) =>
        withDeadline(
          async (s) => {
            const engine = await this.input();
            await engine.perform(a, s);
            const wantShot = req.screenshot !== false;
            let shot: Screenshot | undefined;
            let unsettled: boolean | undefined;
            if (wantShot) {
              const c = await this.x();
              const settle = await waitForSettle<Frame>({
                grab: () => c.capture(),
                same: (p, q) => p.data.equals(q.data),
                signal: s,
              });
              const e = await encodeFrame(settle.frame, { format: req.format ?? "png" });
              shot = { mime: e.mime, data: e.data.toString("base64"), width: e.width, height: e.height };
              if (!settle.settled) unsettled = true;
            }
            const cursor = await engine.cursor();
            const notes = engine.takeNotes();
            const res: InputResponse = { ok: true, generation: this.control.generation, cursor };
            if (shot) res.screenshot = shot;
            if (unsettled) res.unsettled = true;
            if (notes.length) res.notes = notes;
            return res;
          },
          deadline,
          signal,
        ),
      );
    } catch (e) {
      outcome = e instanceof DeskhandError ? e.code : "internal";
      if (e instanceof DeskhandError && (e.code === "timeout" || e.code === "control_changed")) {
        // Leave nothing pressed after an aborted action.
        this.engine?.releaseAllSync();
      }
      throw e;
    } finally {
      const ms = performance.now() - t0;
      this.record(a.action, actor, ms, outcome);
      log.info("input", { action: a.action, actor, ms: Math.round(ms), outcome });
    }
  }

  async releaseAll(): Promise<string[]> {
    if (!this.engine) return [];
    return this.engine.releaseAll();
  }

  uptimeSec(): number {
    return Math.round((Date.now() - this.startedAt) / 1000);
  }
}
