/**
 * Lock, generation and the per-desktop serial input queue (design.md "Lock, generation, hand-back").
 * Pure logic: timers are real but injectable via the clock option for tests.
 */
import { EventEmitter } from "node:events";
import { DeskhandError, type Handback, type Lock } from "@deskhand/shared";

export interface ControlOptions {
  /** How long a queued request waits for a human to release the lock (default 30 s). */
  lockWaitMs?: number;
  now?: () => Date;
}

export interface AccessRequest {
  /** Generation the caller last saw; omitted = don't check. */
  generation?: number;
  /** Override the lock wait for this request. */
  lockWaitMs?: number;
  /** Who is asking; the lock holder itself (e.g. "dashboard") is not blocked by its own lock. */
  actor?: string;
}

export interface RunContext {
  /** Generation at the moment the work started. */
  generation: number;
  /** Aborted (with control_changed) if control changes while the work runs. */
  signal: AbortSignal;
}

export class Control extends EventEmitter {
  generation = 1;
  lock: Lock | null = null;
  lastHandback: Handback | null = null;
  readonly lockWaitMs: number;
  private readonly now: () => Date;
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private running = new Set<AbortController>();

  constructor(opts: ControlOptions = {}) {
    super();
    this.lockWaitMs = opts.lockWaitMs ?? 30_000;
    this.now = opts.now ?? (() => new Date());
  }

  get queueLength(): number {
    return this.queued;
  }

  /** Human takes over: generation++, abort running work. */
  takeLock(holder: string): { generation: number; lock: Lock } {
    this.generation++;
    this.lock = { holder, since: this.now().toISOString(), generation: this.generation };
    this.abortRunning();
    this.emit("change", { kind: "lock", generation: this.generation });
    return { generation: this.generation, lock: this.lock };
  }

  /** Hand back: generation++, record the note. */
  releaseLock(note: string | null | undefined): { generation: number; lock: null } {
    this.generation++;
    this.lock = null;
    this.lastHandback = { note: note ?? null, at: this.now().toISOString(), generation: this.generation };
    this.abortRunning();
    this.emit("change", { kind: "unlock", generation: this.generation });
    return { generation: this.generation, lock: null };
  }

  private abortRunning(): void {
    for (const c of this.running) {
      c.abort(new DeskhandError("control_changed", "Control of this desktop changed while the action was running, so it was stopped. Take a screenshot and decide again."));
    }
  }

  /** Resolves when unlocked; rejects with locked_by_user after `ms`. */
  waitUnlocked(ms: number): Promise<void> {
    if (!this.lock) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onChange = () => {
        if (!this.lock) {
          clearTimeout(t);
          this.off("change", onChange);
          resolve();
        }
      };
      const t = setTimeout(() => {
        this.off("change", onChange);
        reject(new DeskhandError("locked_by_user", undefined, { holder: this.lock?.holder, since: this.lock?.since }));
      }, ms);
      this.on("change", onChange);
    });
  }

  /** Lock wait + generation check, without queueing (exec uses this). */
  async checkAccess(req: AccessRequest): Promise<number> {
    const isHolder = this.lock !== null && req.actor !== undefined && req.actor === this.lock.holder;
    if (!isHolder) await this.waitUnlocked(req.lockWaitMs ?? this.lockWaitMs);
    if (req.generation !== undefined && req.generation !== this.generation) {
      throw new DeskhandError("control_changed", undefined, { generation: this.generation });
    }
    return this.generation;
  }

  /**
   * Run `work` exclusively (one input action at a time per desktop). When the request reaches the
   * front: locked → wait up to lockWaitMs then locked_by_user; generation differs → control_changed.
   * The queue moves on when `work`'s promise settles, so `work` must enforce its own deadline.
   */
  run<T>(req: AccessRequest, work: (ctx: RunContext) => Promise<T>): Promise<T> {
    this.queued++;
    const result = this.tail.then(async () => {
      this.queued--;
      const generation = await this.checkAccess(req);
      const controller = new AbortController();
      this.running.add(controller);
      try {
        return await work({ generation, signal: controller.signal });
      } finally {
        this.running.delete(controller);
      }
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
}
