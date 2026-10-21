/**
 * X11 connection via the `x11` npm package: XTEST input, GetImage capture, pointer query,
 * keyboard mapping and active-window title. One connection, reconnected if the X server restarts.
 */
import { DeskhandError } from "@deskhand/shared";
import x11 from "x11";
import { log } from "./log.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Cb<T> = (err: unknown, v: T) => void;
const call = <T>(fn: (cb: Cb<T>) => void): Promise<T> =>
  new Promise<T>((resolve, reject) => fn((e, v) => (e ? reject(e instanceof Error ? e : new Error(String((e as any)?.message ?? e))) : resolve(v))));

export interface Frame {
  /** Raw pixels, 4 bytes per pixel, BGRX (little-endian ZPixmap, depth 24). */
  data: Buffer;
  width: number;
  height: number;
}

export class XConn {
  dead = false;
  readonly root: number;
  readonly width: number;
  readonly height: number;
  readonly minKeycode: number;
  readonly maxKeycode: number;

  private constructor(
    private readonly display: any,
    private readonly X: any,
    private readonly xtest: any,
  ) {
    const screen = display.screen[0];
    this.root = screen.root;
    this.width = screen.pixel_width;
    this.height = screen.pixel_height;
    this.minKeycode = display.min_keycode;
    this.maxKeycode = display.max_keycode;
  }

  private atoms = new Map<string, number>();

  static async connect(displayName = process.env.DISPLAY ?? ":0"): Promise<XConn> {
    const display = await call<any>((cb) => {
      const client = x11.createClient({ display: displayName }, cb);
      client.on("error", (e: unknown) => cb(e, undefined));
    });
    const X = display.client;
    const xtest = await call<any>((cb) => X.require("xtest", cb));
    const conn = new XConn(display, X, xtest);
    X.removeAllListeners("error");
    X.on("error", (e: any) => {
      // Errors for requests without replies (FakeInput, ChangeKeyboardMapping) land here.
      log.warn("x11 error", { error: String(e?.message ?? e) });
    });
    X.on("end", () => {
      conn.dead = true;
      log.warn("x11 connection closed");
    });
    X.on("close", () => {
      conn.dead = true;
    });
    if (display.image_byte_order !== undefined && display.image_byte_order !== 0) {
      log.warn("X server image byte order is MSB-first; colours may be wrong", { order: display.image_byte_order });
    }
    return conn;
  }

  close(): void {
    try {
      this.X.terminate?.();
    } catch {
      /* ignore */
    }
    this.dead = true;
  }

  /** Round trip: everything sent before has been processed by the server. */
  async sync(): Promise<void> {
    await call((cb) => this.X.GetInputFocus(cb));
  }

  async capture(x = 0, y = 0, width = this.width, height = this.height): Promise<Frame> {
    const img = await call<any>((cb) => this.X.GetImage(2 /* ZPixmap */, this.root, x, y, width, height, 0xffffffff, cb));
    if (img.depth !== 24 && img.depth !== 32) throw new DeskhandError("internal", `Unsupported X depth ${img.depth}`);
    return { data: img.data as Buffer, width, height };
  }

  motion(x: number, y: number): void {
    this.xtest.FakeInput(this.xtest.MotionNotify, 0, 0, this.root, x, y);
  }

  button(button: number, down: boolean): void {
    this.xtest.FakeInput(down ? this.xtest.ButtonPress : this.xtest.ButtonRelease, button, 0, this.root, 0, 0);
  }

  key(keycode: number, down: boolean): void {
    this.xtest.FakeInput(down ? this.xtest.KeyPress : this.xtest.KeyRelease, keycode, 0, this.root, 0, 0);
  }

  async pointer(): Promise<[number, number]> {
    const p = await call<any>((cb) => this.X.QueryPointer(this.root, cb));
    return [p.rootX, p.rootY];
  }

  /** Rows of keysyms per keycode, starting at minKeycode. */
  async keyboardMapping(): Promise<number[][]> {
    return call<number[][]>((cb) => this.X.GetKeyboardMapping(this.minKeycode, this.maxKeycode - this.minKeycode + 1, cb));
  }

  changeKeyboardMapping(keycode: number, keysymsPerKeycode: number, keysyms: number[]): void {
    this.X.ChangeKeyboardMapping(keycode, keysymsPerKeycode, keysyms);
  }

  private async atom(name: string): Promise<number> {
    const cached = this.atoms.get(name);
    if (cached !== undefined) return cached;
    const a = await call<number>((cb) => this.X.InternAtom(false, name, cb));
    this.atoms.set(name, a);
    return a;
  }

  private async property(win: number, name: string, type: number): Promise<{ type: number; data: Buffer } | null> {
    const prop = await this.atom(name);
    const r = await call<any>((cb) => this.X.GetProperty(0, win, prop, type, 0, 1 << 20, cb));
    if (!r || !r.data || r.type === 0) return null;
    return { type: r.type, data: r.data as Buffer };
  }

  /** Title of the active window (_NET_ACTIVE_WINDOW → _NET_WM_NAME / WM_NAME), or null. */
  async activeWindowTitle(): Promise<string | null> {
    try {
      const active = await this.property(this.root, "_NET_ACTIVE_WINDOW", 0);
      if (!active || active.data.length < 4) return null;
      const win = active.data.readUInt32LE(0);
      if (!win) return null;
      const utf8 = await this.atom("UTF8_STRING");
      const name = await this.property(win, "_NET_WM_NAME", utf8);
      if (name && name.data.length) return name.data.toString("utf8");
      const legacy = await this.property(win, "WM_NAME", 0);
      return legacy && legacy.data.length ? legacy.data.toString("latin1") : null;
    } catch {
      return null;
    }
  }
}
