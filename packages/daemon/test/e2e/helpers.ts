/** Client helpers for the desktop e2e tests: daemon API, CDP over the daemon proxy, polling. */
import { inject } from "vitest";
import WebSocket from "ws";
import type { ExecResponse, InputAction, InputResponse } from "@deskhand/shared";

export const url = () => inject("daemonUrl");
export const key = () => inject("daemonKey");
export const auth = () => ({ authorization: `Bearer ${key()}` });

export interface ApiResult<T = unknown> {
  status: number;
  body: T;
}

export async function api<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResult<T>> {
  const r = await fetch(url() + path, {
    method,
    headers: { ...auth(), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === "string" || body instanceof Uint8Array ? (body as string) : JSON.stringify(body),
    signal: AbortSignal.timeout(80_000),
  });
  const type = r.headers.get("content-type") ?? "";
  const data = type.includes("json") ? await r.json() : Buffer.from(await r.arrayBuffer());
  return { status: r.status, body: data as T };
}

export async function ok<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await api<T>(method, path, body);
  if (r.status !== 200) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

export async function input(action: InputAction, extra: Record<string, unknown> = {}): Promise<InputResponse> {
  return ok<InputResponse>("POST", "/input", { input: action, screenshot: false, actor: "e2e", ...extra });
}

export async function sh(command: string, timeout_ms = 20_000): Promise<ExecResponse> {
  return ok<ExecResponse>("POST", "/exec", { command, timeout_ms, actor: "e2e" });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until<T>(fn: () => Promise<T | null | undefined | false>, what: string, timeoutMs = 15_000, every = 200): Promise<T> {
  const t0 = Date.now();
  let last: unknown;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) {
      last = e;
    }
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String((last as Error).message ?? last)}` : ""}`);
}

/** A CDP session to one page target, through the daemon's /cdp proxy. */
export class CdpPage {
  private ws!: WebSocket;
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  constructor(readonly targetId: string, private readonly wsUrl: string) {}

  static async open(pageUrl: string): Promise<CdpPage> {
    const t = await ok<{ id: string; webSocketDebuggerUrl: string }>("PUT", `/cdp/json/new?${encodeURI(pageUrl)}`);
    if (!t.webSocketDebuggerUrl.includes("/cdp/devtools/page/")) throw new Error(`ws url not rewritten: ${t.webSocketDebuggerUrl}`);
    const p = new CdpPage(t.id, t.webSocketDebuggerUrl);
    await p.connect();
    await p.send("Page.enable");
    await p.send("Runtime.enable");
    await p.send("Page.bringToFront");
    await until(async () => (await p.eval("document.readyState")) === "complete", "page load");
    return p;
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl, { headers: auth() });
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
      this.ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result);
        }
      });
    });
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval<T = any>(expression: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`eval failed: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
    return r.result.value as T;
  }

  /** Learn the viewport's screen offset by moving the real mouse over the page. */
  async calibrate(): Promise<[number, number]> {
    let i = 0;
    return until(async () => {
      i++;
      // Closing the previous test's tab can re-activate another tab after our bringToFront.
      if (i % 3 === 0) await this.send("Page.bringToFront");
      await input({ action: "mouse_move", coordinate: [640 + (i % 7) * 3, 420 + (i % 5) * 3] });
      return this.eval<[number, number] | null>("window.deskhand && window.deskhand.offset");
    }, "viewport offset");
  }

  async close(): Promise<void> {
    try {
      await ok("GET", `/cdp/json/close/${this.targetId}`);
    } catch {
      /* already closed */
    }
    this.ws?.close();
  }
}

/** Mean absolute difference between two same-size RGB(A) buffers. */
export function meanAbsDiff(a: Buffer, b: Buffer): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.abs(a[i]! - b[i]!);
  return s / n;
}

/** Minimal RFB client handshake over the daemon's /vnc websocket. */
export class RfbClient {
  ws!: WebSocket;
  private buf = Buffer.alloc(0);
  private waiters: (() => void)[] = [];
  closed: { code: number; reason: string } | null = null;
  width = 0;
  height = 0;

  static async connect(query: string): Promise<RfbClient> {
    const c = new RfbClient();
    const wsUrl = url().replace(/^http/, "ws") + `/vnc?${query}`;
    c.ws = new WebSocket(wsUrl, ["binary"], { headers: auth() });
    c.ws.on("message", (d: Buffer) => {
      c.buf = Buffer.concat([c.buf, d]);
      c.waiters.splice(0).forEach((w) => w());
    });
    c.ws.on("close", (code, reason) => {
      c.closed = { code, reason: reason.toString() };
      c.waiters.splice(0).forEach((w) => w());
    });
    await new Promise<void>((resolve, reject) => {
      c.ws.once("open", () => resolve());
      c.ws.once("error", reject);
    });
    await c.handshake();
    return c;
  }

  private async read(n: number, timeoutMs = 10_000): Promise<Buffer> {
    const t0 = Date.now();
    while (this.buf.length < n) {
      if (this.closed) throw new Error(`vnc closed: ${JSON.stringify(this.closed)}`);
      if (Date.now() - t0 > timeoutMs) throw new Error("vnc read timeout");
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 200);
      });
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return Buffer.from(out);
  }

  private async handshake(): Promise<void> {
    const version = (await this.read(12)).toString("latin1");
    if (!version.startsWith("RFB 003.")) throw new Error(`bad server version ${version}`);
    this.ws.send(Buffer.from("RFB 003.008\n", "latin1"));
    const n = (await this.read(1))[0]!;
    if (n === 0) throw new Error("server refused connection");
    const types = [...(await this.read(n))];
    if (!types.includes(1)) throw new Error(`no None security: ${types}`);
    this.ws.send(Buffer.from([1]));
    const result = (await this.read(4)).readUInt32BE(0);
    if (result !== 0) throw new Error("security failed");
    this.ws.send(Buffer.from([1])); // ClientInit shared
    const init = await this.read(24);
    this.width = init.readUInt16BE(0);
    this.height = init.readUInt16BE(2);
    const nameLen = init.readUInt32BE(20);
    await this.read(nameLen);
  }

  pointer(x: number, y: number, mask = 0): void {
    const b = Buffer.alloc(6);
    b[0] = 5;
    b[1] = mask;
    b.writeUInt16BE(x, 2);
    b.writeUInt16BE(y, 4);
    this.ws.send(b);
  }

  close(): void {
    this.ws.close();
  }
}
