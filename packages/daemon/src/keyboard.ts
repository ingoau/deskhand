/**
 * Keysym → keycode resolution on the live keymap. Keysyms with no keycode (most non-ASCII text,
 * emoji, unusual keys) are typed by temporarily binding them to spare keycodes with
 * ChangeKeyboardMapping (the spike's approach; xdotool does the same).
 */
import { XK } from "./keys.js";
import type { XConn } from "./xconn.js";
import { sleep } from "./util.js";

export interface KeyRef {
  code: number;
  /** Needs Shift (keysym is on the second level). */
  shift: boolean;
}

/** Time for clients to process MappingNotify before we use a freshly mapped keycode. */
const REMAP_SETTLE_MS = 30;

export class Keyboard {
  private perCode = 0;
  private symToKey = new Map<number, KeyRef>();
  private spare: number[] = [];
  /** Spare keycodes currently bound to a keysym by us. */
  private temp = new Map<number, number>(); // keysym → keycode
  private loaded = false;

  constructor(private readonly x: XConn) {}

  async load(): Promise<void> {
    const map = await this.x.keyboardMapping();
    this.perCode = map[0]?.length ?? 0;
    this.symToKey.clear();
    this.spare = [];
    map.forEach((row, i) => {
      const code = this.x.minKeycode + i;
      if (row.every((s) => s === 0)) {
        this.spare.push(code);
        return;
      }
      // Levels 0 and 1 only (plain and Shift); AltGr levels go through remapping instead.
      for (let level = 0; level < Math.min(2, row.length); level++) {
        const s = row[level]!;
        if (s && !this.symToKey.has(s)) this.symToKey.set(s, { code, shift: level === 1 });
      }
    });
    // Level 0 of a pair like (a, A) may list only the lower-case symbol; X derives the upper case.
    for (let c = 0x61; c <= 0x7a; c++) {
      const lower = this.symToKey.get(c);
      if (lower && !this.symToKey.has(c - 0x20)) this.symToKey.set(c - 0x20, { code: lower.code, shift: true });
    }
    // Keep a couple of spares free for the modifier keysyms if they were missing.
    this.loaded = true;
  }

  get spareCount(): number {
    return this.spare.length;
  }

  lookup(sym: number): KeyRef | null {
    return this.symToKey.get(sym) ?? null;
  }

  get shiftCode(): number {
    return this.lookup(XK.Shift_L)?.code ?? 50;
  }

  /**
   * Make sure every keysym in `syms` has a keycode, binding up to spareCount unmapped ones to
   * spare keycodes. Returns the keysyms that could not be bound (caller should split the batch).
   */
  async ensure(syms: Iterable<number>): Promise<number[]> {
    if (!this.loaded) await this.load();
    const missing: number[] = [];
    for (const s of new Set(syms)) {
      if (!this.symToKey.has(s) && !this.temp.has(s)) missing.push(s);
    }
    if (missing.length === 0) return [];
    // Reuse spare keycodes not holding anything we still need.
    const free = this.spare.filter((c) => ![...this.temp.values()].includes(c));
    const overflow: number[] = [];
    let changed = false;
    for (const s of missing) {
      const code = free.shift();
      if (code === undefined) {
        overflow.push(s);
        continue;
      }
      this.x.changeKeyboardMapping(code, this.perCode, new Array(this.perCode).fill(s));
      this.temp.set(s, code);
      changed = true;
    }
    if (changed) {
      await this.x.sync();
      await sleep(REMAP_SETTLE_MS);
    }
    return overflow;
  }

  /** Resolve a keysym to a key, including temporary bindings. */
  resolve(sym: number): KeyRef | null {
    const k = this.symToKey.get(sym);
    if (k) return k;
    const t = this.temp.get(sym);
    return t !== undefined ? { code: t, shift: false } : null;
  }

  /** Unbind all temporary keycodes. */
  async releaseTemp(): Promise<void> {
    if (this.temp.size === 0) return;
    for (const code of this.temp.values()) this.x.changeKeyboardMapping(code, this.perCode, new Array(this.perCode).fill(0));
    this.temp.clear();
    await this.x.sync();
  }
}
