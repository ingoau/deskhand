/**
 * A fake control daemon implementing the contract in packages/shared/src/daemon.ts well enough
 * to develop and test the manager, MCP server and dashboard without the real desktop image.
 *
 * Self-contained on purpose: only Node built-ins and erasable TypeScript, so the stand-in test
 * image can run it with plain `node fake-daemon.ts` (Node 24 strips types).
 *
 * - Screenshots are generated PNGs (background colour changes with every action, a red square
 *   marks the cursor) so consecutive screenshots differ.
 * - Lock/generation semantics follow docs/design.md: input waits for the lock up to lockWaitMs,
 *   then 423 locked_by_user; a stale generation gets 409 control_changed.
 * - Test hooks under /_fake/* (authenticated): recorded inputs, injected delays/hangs/unhealthy.
 */
import http from "node:http";
import crypto from "node:crypto";
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { Duplex } from "node:stream";

export interface FakeDaemonOptions {
  port?: number;
  host?: string;
  key: string;
  width?: number;
  height?: number;
  /** Where /files reads and writes; paths are joined under it. Unset: the real filesystem root. */
  filesRoot?: string;
  lockWaitMs?: number;
  version?: string;
  apiVersion?: number;
}

export interface FakeInputRecord {
  at: string;
  input: Record<string, unknown>;
  generation: number | undefined;
  actor: string | undefined;
}

interface Behavior {
  /** Extra delay before each input completes (ms). */
  inputDelayMs: number;
  /** Never answer /input (simulates a wedged X server). */
  hang: boolean;
  /** /health and /state fail with 500. */
  unhealthy: boolean;
  /** Report this apiVersion from /health and /state. */
  apiVersion?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- PNG

function crc32(buf: Buffer): number {
  const z = zlib as unknown as { crc32?: (b: Buffer) => number };
  if (z.crc32) return z.crc32(buf) >>> 0;
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function makePng(width: number, height: number, bg: [number, number, number], marks: Array<[number, number]> = []): Buffer {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  const row = Buffer.alloc(w * 3);
  for (let x = 0; x < w; x++) {
    row[x * 3] = bg[0];
    row[x * 3 + 1] = bg[1];
    row[x * 3 + 2] = bg[2];
  }
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0;
    row.copy(raw, y * stride + 1);
  }
  for (const [mx, my] of marks) {
    for (let y = Math.max(0, my - 4); y <= Math.min(h - 1, my + 4); y++) {
      for (let x = Math.max(0, mx - 4); x <= Math.min(w - 1, mx + 4); x++) {
        const o = y * stride + 1 + x * 3;
        raw[o] = 230;
        raw[o + 1] = 30;
        raw[o + 2] = 30;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 1 })), chunk("IEND", Buffer.alloc(0))]);
}

// ---------------------------------------------------------------- websocket (minimal, for /vnc)

function wsFrame(payload: Buffer, opcode = 2): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Parses client frames out of buf; returns [frames, rest]. */
function wsParse(buf: Buffer): [Array<{ opcode: number; payload: Buffer }>, Buffer] {
  const frames: Array<{ opcode: number; payload: Buffer }> = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off]!;
    const b1 = buf[off + 1]!;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
    }
    const masked = (b1 & 0x80) !== 0;
    const maskLen = masked ? 4 : 0;
    if (buf.length - p < maskLen + len) break;
    const mask = masked ? buf.subarray(p, p + 4) : undefined;
    p += maskLen;
    const payload = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
    frames.push({ opcode: b0 & 0x0f, payload });
    off = p + len;
  }
  return [frames, buf.subarray(off)];
}

// ---------------------------------------------------------------- daemon

interface VncConn {
  socket: Duplex;
  mode: string;
  generation: number;
}

export class FakeDaemon {
  readonly opts: Required<Omit<FakeDaemonOptions, "filesRoot">> & { filesRoot?: string };
  readonly server: http.Server;
  generation = 1;
  lock: { holder: string; since: string; generation: number } | null = null;
  lastHandback: { note: string | null; at: string; generation: number } | null = null;
  lastAction: { action: string; at: string; actor: string | null } | null = null;
  cursor: [number, number];
  heldButtons: number[] = [];
  inputs: FakeInputRecord[] = [];
  actionCount = 0;
  title: string | null = "Fake desktop";
  behavior: Behavior = { inputDelayMs: 0, hang: false, unhealthy: false };
  readonly startedAt = Date.now();
  private queue: Promise<unknown> = Promise.resolve();
  private files = new Map<string, Buffer>();
  private vnc = new Set<VncConn>();
  /** Inputs received over control-mode VNC connections (for tests). */
  vncInputs: Buffer[] = [];

  constructor(opts: FakeDaemonOptions) {
    this.opts = {
      port: opts.port ?? 7000,
      host: opts.host ?? "0.0.0.0",
      key: opts.key,
      width: opts.width ?? 1280,
      height: opts.height ?? 800,
      filesRoot: opts.filesRoot,
      lockWaitMs: opts.lockWaitMs ?? 30_000,
      version: opts.version ?? "0.1.0",
      apiVersion: opts.apiVersion ?? 1,
    };
    this.cursor = [Math.floor(this.opts.width / 2), Math.floor(this.opts.height / 2)];
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        if (!res.headersSent) this.send(res, 500, { error: { code: "internal", message: String((e as Error)?.message ?? e) } });
        else res.destroy();
      });
    });
    this.server.on("upgrade", (req, socket) => this.upgrade(req, socket));
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.opts.port, this.opts.host, () => {
        this.server.off("error", reject);
        resolve((this.server.address() as { port: number }).port);
      });
    });
  }

  close(): Promise<void> {
    for (const c of this.vnc) c.socket.destroy();
    this.vnc.clear();
    this.server.closeAllConnections?.();
    return new Promise((r) => this.server.close(() => r()));
  }

  get apiVersion(): number {
    return this.behavior.apiVersion ?? this.opts.apiVersion;
  }

  private send(res: http.ServerResponse, status: number, body: unknown) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { "content-type": "application/json", "content-length": data.length });
    res.end(data);
  }

  private err(res: http.ServerResponse, status: number, code: string, message: string) {
    this.send(res, status, { error: { code, message } });
  }

  private authed(req: http.IncomingMessage): boolean {
    return req.headers.authorization === `Bearer ${this.opts.key}`;
  }

  private async body(req: http.IncomingMessage): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const c of req) parts.push(c as Buffer);
    return Buffer.concat(parts);
  }

  private async jsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const b = await this.body(req);
    if (b.length === 0) return {};
    return JSON.parse(b.toString("utf8")) as Record<string, unknown>;
  }

  state() {
    return {
      version: this.opts.version,
      apiVersion: this.apiVersion,
      title: this.title,
      screen: { width: this.opts.width, height: this.opts.height },
      lock: this.lock,
      generation: this.generation,
      lastHandback: this.lastHandback,
      lastAction: this.lastAction,
      uptimeSec: (Date.now() - this.startedAt) / 1000,
      heldButtons: this.heldButtons,
      cdpAvailable: false,
    };
  }

  private bg(): [number, number, number] {
    const n = this.actionCount;
    return [(40 + n * 37) % 200, (60 + n * 53) % 200, (90 + n * 71) % 200];
  }

  screenshotPng(scale = 1, region?: number[]): { png: Buffer; width: number; height: number } {
    const { width: W, height: H } = this.opts;
    if (region && region.length === 4) {
      const [x0, y0, x1, y1] = region as [number, number, number, number];
      const rw = Math.max(1, x1 - x0);
      const rh = Math.max(1, y1 - y0);
      const f = Math.min(W / rw, H / rh);
      const w = Math.round(rw * f);
      const h = Math.round(rh * f);
      return { png: makePng(w, h, this.bg()), width: w, height: h };
    }
    const w = Math.max(1, Math.round(W * scale));
    const h = Math.max(1, Math.round(H * scale));
    return { png: makePng(w, h, this.bg(), [[Math.round(this.cursor[0] * scale), Math.round(this.cursor[1] * scale)]]), width: w, height: h };
  }

  private shotJson() {
    const s = this.screenshotPng();
    return { mime: "image/png", data: s.png.toString("base64"), width: s.width, height: s.height };
  }

  /** Runs fn when it reaches the front of the queue, after the lock and generation checks. */
  private async queued<T>(
    res: http.ServerResponse,
    generation: number | undefined,
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    const run = async (): Promise<T | undefined> => {
      const started = Date.now();
      while (this.lock && Date.now() - started < this.opts.lockWaitMs) await sleep(25);
      if (this.lock) {
        this.err(res, 423, "locked_by_user", "The user is controlling this desktop; wait and try again.");
        return undefined;
      }
      if (generation !== undefined && generation !== this.generation) {
        this.err(res, 409, "control_changed", "Control of this desktop changed while the action was queued, so it was not performed.");
        return undefined;
      }
      return fn();
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private bumpGeneration() {
    this.generation++;
    for (const c of this.vnc) {
      if (c.mode === "control" && c.generation !== this.generation) {
        c.socket.end(wsFrame(Buffer.alloc(0), 8));
        this.vnc.delete(c);
      }
    }
  }

  private applyInput(input: Record<string, unknown>): string[] {
    const notes: string[] = [];
    const coord = input.coordinate as [number, number] | undefined;
    switch (input.action) {
      case "left_click":
      case "right_click":
      case "middle_click":
      case "double_click":
      case "triple_click":
      case "mouse_move":
      case "scroll":
        if (coord) this.cursor = [coord[0], coord[1]];
        break;
      case "left_click_drag":
        this.cursor = [(input.coordinate as number[])[0]!, (input.coordinate as number[])[1]!];
        break;
      case "left_mouse_down":
        if (!this.heldButtons.includes(1)) this.heldButtons.push(1);
        break;
      case "left_mouse_up":
        this.heldButtons = this.heldButtons.filter((b) => b !== 1);
        break;
    }
    return notes;
  }

  private resolveFile(p: string): string {
    if (!this.opts.filesRoot) return p;
    return path.join(this.opts.filesRoot, path.normalize(p));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", "http://fake");
    const route = `${req.method} ${url.pathname}`;
    if (route === "GET /health") {
      if (this.behavior.unhealthy) return this.err(res, 500, "internal", "unhealthy");
      return this.send(res, 200, { ok: true, version: this.opts.version, apiVersion: this.apiVersion });
    }
    if (!this.authed(req)) return this.err(res, 401, "unauthorized", "bad daemon key");
    switch (route) {
      case "GET /state":
        if (this.behavior.unhealthy) return this.err(res, 500, "internal", "unhealthy");
        return this.send(res, 200, this.state());
      case "GET /cursor":
        return this.send(res, 200, { cursor: this.cursor });
      case "GET /screenshot": {
        const scale = url.searchParams.has("scale") ? Number(url.searchParams.get("scale")) : 1;
        const region = url.searchParams.get("region")?.split(",").map(Number);
        const s = this.screenshotPng(scale, region);
        if ((req.headers.accept ?? "").includes("application/json")) {
          return this.send(res, 200, { mime: "image/png", data: s.png.toString("base64"), width: s.width, height: s.height });
        }
        res.writeHead(200, { "content-type": "image/png", "content-length": s.png.length });
        return res.end(s.png);
      }
      case "POST /input": {
        const body = await this.jsonBody(req);
        const input = body.input as Record<string, unknown> | undefined;
        if (!input || typeof input.action !== "string") return this.err(res, 400, "invalid_argument", "missing input.action");
        const generation = body.generation as number | undefined;
        const out = await this.queued(res, generation, async () => {
          if (this.behavior.hang) await new Promise(() => undefined);
          if (this.behavior.inputDelayMs) await sleep(this.behavior.inputDelayMs);
          if (input.action === "wait" || input.action === "hold_key") await sleep(Math.min(Number(input.duration ?? 0), 300) * 1000);
          this.inputs.push({ at: new Date().toISOString(), input, generation, actor: body.actor as string | undefined });
          this.actionCount++;
          this.lastAction = { action: String(input.action), at: new Date().toISOString(), actor: (body.actor as string) ?? null };
          const notes = this.applyInput(input);
          return {
            ok: true,
            generation: this.generation,
            cursor: this.cursor,
            ...(body.screenshot === false ? {} : { screenshot: this.shotJson() }),
            ...(notes.length ? { notes } : {}),
          };
        });
        if (out) this.send(res, 200, out);
        return;
      }
      case "POST /lock": {
        const body = await this.jsonBody(req);
        this.bumpGeneration();
        this.heldButtons = [];
        this.lock = { holder: String(body.holder ?? "dashboard"), since: new Date().toISOString(), generation: this.generation };
        return this.send(res, 200, { generation: this.generation, lock: this.lock });
      }
      case "DELETE /lock": {
        const body = await this.jsonBody(req).catch(() => ({}) as Record<string, unknown>);
        this.bumpGeneration();
        this.lock = null;
        this.lastHandback = { note: (body.note as string | null | undefined) ?? null, at: new Date().toISOString(), generation: this.generation };
        return this.send(res, 200, { generation: this.generation, lock: null });
      }
      case "POST /exec": {
        const body = await this.jsonBody(req);
        const out = await this.queued(res, body.generation as number | undefined, () => this.exec(String(body.command ?? ""), Number(body.timeout_ms ?? 60_000)));
        if (out) this.send(res, 200, out);
        return;
      }
      case "GET /files": {
        const p = url.searchParams.get("path");
        if (!p || !p.startsWith("/")) return this.err(res, 400, "invalid_argument", "path must be absolute");
        let data: Buffer | undefined = this.files.get(p);
        if (!data) {
          try {
            data = await fs.promises.readFile(this.resolveFile(p));
          } catch {
            return this.err(res, 404, "not_found", `No such file in the desktop: ${p}`);
          }
        }
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": data.length });
        return res.end(data);
      }
      case "PUT /files": {
        const p = url.searchParams.get("path");
        if (!p || !p.startsWith("/")) return this.err(res, 400, "invalid_argument", "path must be absolute");
        const data = await this.body(req);
        const target = this.resolveFile(p);
        try {
          await fs.promises.mkdir(path.dirname(target), { recursive: true });
          await fs.promises.writeFile(target, data);
        } catch {
          this.files.set(p, data);
        }
        return this.send(res, 200, { bytes: data.length });
      }
      case "GET /ui-tree":
        return this.send(res, 200, {
          role: "desktop",
          name: "fake",
          children: [{ role: "frame", name: this.title ?? "", box: [0, 0, this.opts.width, this.opts.height], children: [{ role: "push button", name: "OK", states: ["enabled"], box: [600, 380, 80, 30] }] }],
        });
      case "POST /quiesce":
        await this.body(req);
        return this.send(res, 200, { ok: true });
      case "GET /_fake/inputs":
        return this.send(res, 200, { inputs: this.inputs, vncInputs: this.vncInputs.map((b) => b.toString("base64")) });
      case "POST /_fake/behavior": {
        const body = await this.jsonBody(req);
        Object.assign(this.behavior, body);
        if (typeof body.title === "string") this.title = body.title;
        return this.send(res, 200, this.behavior);
      }
      default:
        return this.err(res, 404, "not_found", `no route ${route}`);
    }
  }

  private exec(command: string, timeoutMs: number) {
    return new Promise<Record<string, unknown>>((resolve) => {
      const child = spawn("sh", ["-c", command], { stdio: ["ignore", "pipe", "pipe"], detached: true });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const cap = 1_000_000;
      child.stdout.on("data", (d: Buffer) => (stdout = (stdout + d.toString()).slice(0, cap)));
      child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(0, cap)));
      const t = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, timeoutMs);
      child.on("close", (code, signal) => {
        clearTimeout(t);
        this.actionCount++;
        resolve({ exitCode: code, signal: signal ?? null, timedOut, stdout, stderr, truncated: false });
      });
    });
  }

  private upgrade(req: http.IncomingMessage, socket: Duplex) {
    const url = new URL(req.url ?? "/", "http://fake");
    if (url.pathname !== "/vnc" || !this.authed(req)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    const key = req.headers["sec-websocket-key"];
    const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    const proto = req.headers["sec-websocket-protocol"]?.split(",")[0]?.trim();
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        (proto ? `Sec-WebSocket-Protocol: ${proto}\r\n` : "") +
        "\r\n",
    );
    const conn: VncConn = { socket, mode: url.searchParams.get("mode") ?? "view", generation: Number(url.searchParams.get("generation") ?? this.generation) };
    this.vnc.add(conn);
    socket.write(wsFrame(Buffer.from("RFB 003.008\n")));
    let pending = Buffer.alloc(0);
    socket.on("data", (d: Buffer) => {
      const [frames, rest] = wsParse(Buffer.concat([pending, d]));
      pending = Buffer.from(rest);
      for (const f of frames) {
        if (f.opcode === 8) {
          socket.end(wsFrame(Buffer.alloc(0), 8));
          this.vnc.delete(conn);
          return;
        }
        if (f.opcode === 9) {
          socket.write(wsFrame(f.payload, 10));
          continue;
        }
        const allowed = conn.mode === "control" && this.lock !== null && conn.generation === this.generation;
        if (allowed) {
          this.vncInputs.push(f.payload);
          socket.write(wsFrame(f.payload));
        }
      }
    });
    socket.on("close", () => this.vnc.delete(conn));
    socket.on("error", () => this.vnc.delete(conn));
  }
}

export async function startFakeDaemon(opts: FakeDaemonOptions): Promise<{ daemon: FakeDaemon; port: number }> {
  const daemon = new FakeDaemon(opts);
  const port = await daemon.listen();
  return { daemon, port };
}

// Run directly (stand-in desktop image): node fake-daemon.ts
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [w, h] = (process.env.DESKHAND_SCREEN ?? "1280x800").split("x").map(Number);
  const d = new FakeDaemon({
    key: process.env.DESKHAND_DAEMON_KEY ?? "",
    port: Number(process.env.FAKE_DAEMON_PORT ?? 7000),
    width: w,
    height: h,
    lockWaitMs: process.env.FAKE_LOCK_WAIT_MS ? Number(process.env.FAKE_LOCK_WAIT_MS) : undefined,
    version: process.env.FAKE_DAEMON_VERSION,
    apiVersion: process.env.FAKE_DAEMON_API_VERSION ? Number(process.env.FAKE_DAEMON_API_VERSION) : undefined,
  });
  d.listen().then((port) => console.log(JSON.stringify({ msg: "fake daemon listening", port })));
  const stop = () => d.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
