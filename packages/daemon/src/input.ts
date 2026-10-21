/**
 * Computer-use actions as real X events through XTEST (plan: "Input fidelity").
 */
import { DeskhandError, type InputAction } from "@deskhand/shared";
import { heldMovePath, planDrag, type Point } from "./drag.js";
import { Keyboard } from "./keyboard.js";
import { charToKeysym, keysymName, parseKeyText, parseModifiers } from "./keys.js";
import { log } from "./log.js";
import { checkAborted, sleep } from "./util.js";
import type { XConn } from "./xconn.js";

export const BUTTON = { left: 1, middle: 2, right: 3, scrollUp: 4, scrollDown: 5, scrollLeft: 6, scrollRight: 7 } as const;
const BUTTON_NAMES: Record<number, string> = { 1: "left", 2: "middle", 3: "right" };

export const TIMING = {
  /** After moving onto a click target, so hover handlers run. */
  clickHoverMs: 30,
  /** Button down → up. */
  clickHoldMs: 25,
  /** Between the clicks of a double/triple click (well inside a 400 ms double-click time). */
  multiClickGapMs: 70,
  scrollGapMs: 25,
  /** Between typed characters. */
  typeGapMs: 6,
  keyGapMs: 25,
  heldMoveStepMs: 8,
  /** Release a button held without left_mouse_up after this long. */
  stuckButtonMs: 30_000,
  /**
   * Separate click actions must not merge into one multi-click: if the previous click ended less
   * than this long ago near the same spot, wait out the rest (GTK/Chromium double-click time).
   */
  multiClickIntervalMs: 500,
  multiClickDistancePx: 8,
};

export class InputEngine {
  readonly keyboard: Keyboard;
  /** Buttons we have pressed and not released. */
  readonly heldButtons = new Set<number>();
  /** Keycodes we have pressed and not released. */
  private readonly heldKeys = new Set<number>();
  /** Notes for the next response (e.g. "a stuck button was released"). */
  private pendingNotes: string[] = [];
  private stuckTimer: NodeJS.Timeout | null = null;
  private lastClick: { at: number; pos: Point } | null = null;

  constructor(
    private readonly x: XConn,
    private readonly opts: { stuckButtonMs?: number } = {},
  ) {
    this.keyboard = new Keyboard(x);
  }

  get width(): number {
    return this.x.width;
  }
  get height(): number {
    return this.x.height;
  }

  takeNotes(): string[] {
    const n = this.pendingNotes;
    this.pendingNotes = [];
    return n;
  }

  addNote(note: string): void {
    this.pendingNotes.push(note);
  }

  private checkPoint(p: Point, what = "coordinate"): Point {
    const [x, y] = p;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= this.x.width || y >= this.x.height) {
      throw new DeskhandError(
        "invalid_argument",
        `${what} [${x}, ${y}] is outside the screen; valid range is [0, 0] to [${this.x.width - 1}, ${this.x.height - 1}].`,
      );
    }
    return p;
  }

  async cursor(): Promise<Point> {
    return this.x.pointer();
  }

  private move(p: Point): void {
    this.x.motion(p[0], p[1]);
  }

  private async moveTo(p: Point, signal?: AbortSignal): Promise<boolean> {
    // Always ask the server: a human (VNC) or an app may have moved the pointer.
    const cur = await this.x.pointer();
    if (cur[0] === p[0] && cur[1] === p[1]) return false;
    if (this.heldButtons.size > 0) {
      for (const q of heldMovePath(cur, p)) {
        this.move(q);
        await sleep(TIMING.heldMoveStepMs, signal);
      }
    } else {
      this.move(p);
    }
    return true;
  }

  private buttonDown(b: number): void {
    this.x.button(b, true);
    this.heldButtons.add(b);
  }

  private buttonUp(b: number): void {
    this.x.button(b, false);
    this.heldButtons.delete(b);
  }

  private keyDown(code: number): void {
    this.x.key(code, true);
    this.heldKeys.add(code);
  }

  private keyUp(code: number): void {
    this.x.key(code, false);
    this.heldKeys.delete(code);
  }

  /** Press keysyms in order (resolving Shift where needed); returns keycodes to release in reverse. */
  private async pressSyms(syms: number[]): Promise<number[]> {
    const overflow = await this.keyboard.ensure(syms);
    if (overflow.length) throw new DeskhandError("invalid_argument", `Too many unusual keys in one combination (${overflow.map(keysymName).join(", ")}).`);
    const pressed: number[] = [];
    for (const s of syms) {
      const k = this.keyboard.resolve(s);
      if (!k) throw new DeskhandError("invalid_argument", `No key for ${keysymName(s)}.`);
      if (k.shift && !pressed.includes(this.keyboard.shiftCode)) {
        this.keyDown(this.keyboard.shiftCode);
        pressed.push(this.keyboard.shiftCode);
      }
      if (!pressed.includes(k.code)) {
        this.keyDown(k.code);
        pressed.push(k.code);
      }
    }
    return pressed;
  }

  private releaseCodes(codes: number[]): void {
    for (const c of [...codes].reverse()) if (this.heldKeys.has(c)) this.keyUp(c);
  }

  private armStuckTimer(): void {
    this.clearStuckTimer();
    const ms = this.opts.stuckButtonMs ?? TIMING.stuckButtonMs;
    this.stuckTimer = setTimeout(() => {
      const released = this.releaseAllSync();
      if (released.length) {
        const note = `The ${released.join(", ")} was released automatically after ${Math.round(ms / 1000)} s without left_mouse_up.`;
        this.pendingNotes.push(note);
        log.warn("stuck button released", { released });
      }
    }, ms);
    this.stuckTimer.unref();
  }

  private clearStuckTimer(): void {
    if (this.stuckTimer) clearTimeout(this.stuckTimer);
    this.stuckTimer = null;
  }

  /** Release every button and key we hold. Returns human names of what was released. */
  releaseAllSync(): string[] {
    const released: string[] = [];
    for (const b of [...this.heldButtons]) {
      this.buttonUp(b);
      released.push(`${BUTTON_NAMES[b] ?? `button ${b}`} mouse button`);
    }
    for (const c of [...this.heldKeys]) {
      this.keyUp(c);
      released.push(`key ${c}`);
    }
    this.clearStuckTimer();
    return released;
  }

  async releaseAll(): Promise<string[]> {
    const r = this.releaseAllSync();
    await this.keyboard.releaseTemp().catch(() => undefined);
    await this.x.sync().catch(() => undefined);
    return r;
  }

  /** Perform one action. Throws DeskhandError for bad arguments; honours `signal` between steps. */
  async perform(a: InputAction, signal: AbortSignal): Promise<void> {
    switch (a.action) {
      case "left_click":
      case "right_click":
      case "middle_click":
      case "double_click":
      case "triple_click": {
        const button = a.action === "right_click" ? BUTTON.right : a.action === "middle_click" ? BUTTON.middle : BUTTON.left;
        const count = a.action === "double_click" ? 2 : a.action === "triple_click" ? 3 : 1;
        const mods = parseModifiers(a.text);
        const target = a.coordinate ? this.checkPoint(a.coordinate) : null;
        let modCodes: number[] = [];
        try {
          if (target && (await this.moveTo(target, signal))) await sleep(TIMING.clickHoverMs, signal);
          const pos = target ?? (await this.x.pointer());
          if (this.lastClick) {
            const since = performance.now() - this.lastClick.at;
            const near = Math.hypot(pos[0] - this.lastClick.pos[0], pos[1] - this.lastClick.pos[1]) <= TIMING.multiClickDistancePx;
            if (near && since < TIMING.multiClickIntervalMs) await sleep(TIMING.multiClickIntervalMs - since, signal);
          }
          modCodes = await this.pressSyms(mods);
          for (let i = 0; i < count; i++) {
            if (i > 0) await sleep(TIMING.multiClickGapMs, signal);
            this.buttonDown(button);
            await sleep(TIMING.clickHoldMs, signal);
            this.buttonUp(button);
          }
          this.lastClick = { at: performance.now(), pos };
        } finally {
          if (this.heldButtons.has(button)) this.buttonUp(button);
          this.releaseCodes(modCodes);
        }
        break;
      }
      case "mouse_move":
        await this.moveTo(this.checkPoint(a.coordinate), signal);
        break;
      case "left_mouse_down":
        this.buttonDown(BUTTON.left);
        this.armStuckTimer();
        break;
      case "left_mouse_up":
        if (this.heldButtons.has(BUTTON.left)) this.buttonUp(BUTTON.left);
        else this.x.button(BUTTON.left, false);
        if (this.heldButtons.size === 0) this.clearStuckTimer();
        break;
      case "left_click_drag": {
        const start = this.checkPoint(a.start_coordinate, "start_coordinate");
        const end = this.checkPoint(a.coordinate);
        const plan = planDrag(start, end, { durationMs: a.duration_ms, holdMs: a.hold_ms });
        const mods = parseModifiers(a.text);
        let modCodes: number[] = [];
        try {
          // 1. move to start and pause for hover states (no held-button interpolation here)
          if (this.heldButtons.has(BUTTON.left)) this.buttonUp(BUTTON.left);
          this.move(start);
          await sleep(plan.hoverMs, signal);
          // 2. press (with modifiers)
          modCodes = await this.pressSyms(mods);
          this.buttonDown(BUTTON.left);
          await sleep(plan.pressMs, signal);
          // 3. nudge past drag thresholds
          this.move(plan.nudge);
          // 4. eased steps to the target
          for (const p of plan.steps) {
            await sleep(plan.stepDelayMs, signal);
            this.move(p);
          }
          // 5. rest on the target so drop targets register
          await sleep(plan.holdMs, signal);
          // 6. release
          this.buttonUp(BUTTON.left);
        } finally {
          if (this.heldButtons.has(BUTTON.left)) this.buttonUp(BUTTON.left);
          this.releaseCodes(modCodes);
        }
        break;
      }
      case "scroll": {
        const target = a.coordinate ? this.checkPoint(a.coordinate) : null;
        const button = { up: BUTTON.scrollUp, down: BUTTON.scrollDown, left: BUTTON.scrollLeft, right: BUTTON.scrollRight }[a.scroll_direction];
        const mods = parseModifiers(a.text);
        let modCodes: number[] = [];
        try {
          if (target && (await this.moveTo(target, signal))) await sleep(TIMING.clickHoverMs, signal);
          modCodes = await this.pressSyms(mods);
          for (let i = 0; i < a.scroll_amount; i++) {
            if (i > 0) await sleep(TIMING.scrollGapMs, signal);
            this.x.button(button, true);
            this.x.button(button, false);
          }
        } finally {
          this.releaseCodes(modCodes);
        }
        break;
      }
      case "type":
        await this.typeText(a.text, signal);
        break;
      case "key": {
        const combos = parseKeyText(a.text);
        const repeat = a.repeat ?? 1;
        try {
          for (let r = 0; r < repeat; r++) {
            for (const c of combos) {
              if (r > 0 || c !== combos[0]) await sleep(TIMING.keyGapMs, signal);
              const codes = await this.pressSyms([...c.modifiers, ...(c.key !== null ? [c.key] : [])]);
              await sleep(10, signal);
              this.releaseCodes(codes);
            }
          }
        } finally {
          this.releaseCodes([...this.heldKeys]);
          await this.keyboard.releaseTemp();
        }
        break;
      }
      case "hold_key": {
        const combos = parseKeyText(a.text);
        const syms = combos.flatMap((c) => [...c.modifiers, ...(c.key !== null ? [c.key] : [])]);
        let codes: number[] = [];
        try {
          codes = await this.pressSyms(syms);
          await sleep(a.duration * 1000, signal);
        } finally {
          this.releaseCodes(codes);
          await this.keyboard.releaseTemp();
        }
        break;
      }
      case "wait":
        await sleep(a.duration * 1000, signal);
        break;
      default: {
        const never: never = a;
        throw new DeskhandError("invalid_argument", `Unknown action ${(never as { action: string }).action}`);
      }
    }
    await this.x.sync();
  }

  private async typeText(text: string, signal: AbortSignal): Promise<void> {
    const chars = [...text.replace(/\r\n/g, "\n")];
    const syms = chars.map(charToKeysym);
    let i = 0;
    try {
      while (i < syms.length) {
        checkAborted(signal);
        // Bind as many unmapped keysyms as there are spare keycodes, type that stretch, repeat.
        let j = i;
        const batch = new Set<number>();
        const cap = Math.max(1, this.keyboard.spareCount);
        while (j < syms.length) {
          const s = syms[j]!;
          if (!this.keyboard.lookup(s) && !batch.has(s)) {
            if (batch.size >= cap) break;
            batch.add(s);
          }
          j++;
        }
        await this.keyboard.releaseTemp();
        const overflow = await this.keyboard.ensure(batch);
        if (overflow.length) throw new DeskhandError("internal", "Could not bind keycodes for typing.");
        for (let k = i; k < j; k++) {
          const ref = this.keyboard.resolve(syms[k]!);
          if (!ref) throw new DeskhandError("internal", `No keycode for ${keysymName(syms[k]!)}.`);
          if (ref.shift) this.keyDown(this.keyboard.shiftCode);
          this.keyDown(ref.code);
          this.keyUp(ref.code);
          if (ref.shift) this.keyUp(this.keyboard.shiftCode);
          if ((k - i) % 16 === 15) await this.x.sync();
          await sleep(TIMING.typeGapMs, signal);
        }
        await this.x.sync();
        i = j;
      }
    } finally {
      this.releaseCodes([...this.heldKeys]);
      await this.keyboard.releaseTemp();
    }
  }
}

/** Expected duration of an action (ms), used to extend the deadline for long actions. */
export function expectedDurationMs(a: InputAction): number {
  switch (a.action) {
    case "wait":
    case "hold_key":
      return a.duration * 1000;
    case "left_click_drag":
      return (a.duration_ms ?? 400) + (a.hold_ms ?? 150) + 200;
    case "type":
      return [...a.text].length * (TIMING.typeGapMs + 4) + 500;
    case "key":
      return (a.repeat ?? 1) * 60;
    case "scroll":
      return a.scroll_amount * TIMING.scrollGapMs;
    default:
      return 0;
  }
}
