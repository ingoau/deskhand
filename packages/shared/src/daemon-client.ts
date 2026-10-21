/**
 * Typed HTTP client for the control daemon contract in ./daemon.ts.
 *
 * Network failures are classified so callers can tell "the action certainly did not
 * happen" (daemon_unavailable: the connection was never made) from "it may have happened"
 * (outcome_unknown: a mutating request timed out or its connection dropped mid-flight).
 */
import { DeskhandError, type ErrorCode } from "./errors.js";
import type { Coordinate, DaemonState, ExecResponse, ImageFormat, InputRequest, InputResponse, LockResponse as LockResponseSchema, Screenshot, UiNodeT } from "./daemon.js";
import type { z } from "zod";
type LockResponse = z.infer<typeof LockResponseSchema>;

export interface DaemonClientOptions {
  /** e.g. http://172.18.0.5:7000 */
  baseUrl: string;
  key: string;
  /** Default timeout for read-only calls (ms). */
  timeoutMs?: number;
}

export interface ScreenshotOptions {
  format?: ImageFormat;
  scale?: number;
  quality?: number;
  /** [x0, y0, x1, y1] */
  region?: [number, number, number, number];
}

const CONNECT_ERRORS = new Set([
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "EADDRNOTAVAIL",
]);

function errCode(e: unknown): string | undefined {
  const err = e as { code?: string; cause?: { code?: string; cause?: { code?: string } } };
  return err?.cause?.code ?? err?.cause?.cause?.code ?? err?.code;
}

function isTimeout(e: unknown): boolean {
  const name = (e as { name?: string })?.name;
  return name === "TimeoutError" || name === "AbortError";
}

export class DaemonClient {
  readonly baseUrl: string;
  private readonly key: string;
  private readonly timeoutMs: number;

  constructor(opts: DaemonClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.key = opts.key;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  get authHeader(): string {
    return `Bearer ${this.key}`;
  }

  private async request(
    method: string,
    path: string,
    opts: { body?: unknown; raw?: Uint8Array; timeoutMs?: number; mutating?: boolean; accept?: string; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { authorization: this.authHeader };
    let body: BodyInit | undefined;
    if (opts.raw) {
      headers["content-type"] = "application/octet-stream";
      body = opts.raw as unknown as BodyInit;
    } else if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    if (opts.accept) headers.accept = opts.accept;
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, { method, headers, body, signal });
    } catch (e) {
      // A pooled keep-alive socket can be stale after a daemon restart; retry reads once.
      const code = errCode(e);
      if (!opts.mutating && !signal.aborted && (code === "UND_ERR_SOCKET" || code === "ECONNRESET")) {
        try {
          res = await fetch(this.baseUrl + path, { method, headers, body, signal });
        } catch (e2) {
          throw this.networkError(e2, false);
        }
      } else {
        throw this.networkError(e, !!opts.mutating);
      }
    }
    if (!res.ok) {
      let parsed: unknown;
      const text = await res.text().catch(() => "");
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      const known = DeskhandError.fromBody(parsed);
      if (known) throw known;
      const code: ErrorCode = res.status === 404 ? "not_found" : res.status === 401 ? "daemon_unavailable" : "internal";
      throw new DeskhandError(code, undefined, { status: res.status, path, body: text.slice(0, 300) });
    }
    return res;
  }

  private networkError(e: unknown, mutating: boolean): DeskhandError {
    if (e instanceof DeskhandError) return e;
    const code = errCode(e);
    if (code && CONNECT_ERRORS.has(code)) return new DeskhandError("daemon_unavailable", undefined, { cause: code });
    if (mutating) return new DeskhandError("outcome_unknown", undefined, { cause: code ?? (e as Error)?.name });
    if (isTimeout(e)) return new DeskhandError("timeout", undefined, { cause: "timeout" });
    return new DeskhandError("daemon_unavailable", undefined, { cause: code ?? (e as Error)?.message });
  }

  private async json<T>(res: Response, mutating = false): Promise<T> {
    try {
      return (await res.json()) as T;
    } catch (e) {
      throw this.networkError(e, mutating);
    }
  }

  async health(timeoutMs = 3000): Promise<{ ok: boolean; version: string; apiVersion: number }> {
    // /health needs no auth, but sending it is harmless.
    return this.json(await this.request("GET", "/health", { timeoutMs }));
  }

  async state(timeoutMs = 3000): Promise<DaemonState> {
    return this.json(await this.request("GET", "/state", { timeoutMs }));
  }

  private screenshotQuery(o: ScreenshotOptions): string {
    const q = new URLSearchParams();
    if (o.format) q.set("format", o.format);
    if (o.scale !== undefined) q.set("scale", String(o.scale));
    if (o.quality !== undefined) q.set("quality", String(o.quality));
    if (o.region) q.set("region", o.region.join(","));
    const s = q.toString();
    return s ? `?${s}` : "";
  }

  async screenshot(o: ScreenshotOptions = {}, timeoutMs = 15_000): Promise<Screenshot> {
    return this.json(await this.request("GET", "/screenshot" + this.screenshotQuery(o), { timeoutMs, accept: "application/json" }));
  }

  /** Raw image bytes and their mime type. */
  async screenshotRaw(o: ScreenshotOptions = {}, timeoutMs = 15_000): Promise<{ mime: string; data: Buffer }> {
    const res = await this.request("GET", "/screenshot" + this.screenshotQuery(o), { timeoutMs, accept: "image/*" });
    const mime = res.headers.get("content-type") ?? "application/octet-stream";
    if (mime.startsWith("application/json")) {
      const shot = (await res.json()) as Screenshot;
      return { mime: shot.mime, data: Buffer.from(shot.data, "base64") };
    }
    return { mime, data: Buffer.from(await res.arrayBuffer()) };
  }

  /** POST /input. Timeouts and dropped connections become outcome_unknown. */
  async input(req: InputRequest, timeoutMs: number, signal?: AbortSignal): Promise<InputResponse> {
    const res = await this.request("POST", "/input", { body: req, timeoutMs, mutating: true, signal });
    return this.json(res, true);
  }

  async cursor(timeoutMs = 3000): Promise<Coordinate> {
    const body = await this.json<{ cursor?: Coordinate; x?: number; y?: number }>(await this.request("GET", "/cursor", { timeoutMs }));
    if (Array.isArray(body.cursor)) return body.cursor;
    if (typeof body.x === "number" && typeof body.y === "number") return [body.x, body.y];
    throw new DeskhandError("internal", "The desktop returned an unexpected cursor position.");
  }

  async lock(holder: string): Promise<LockResponse> {
    return this.json(await this.request("POST", "/lock", { body: { holder }, mutating: true }));
  }

  async unlock(note?: string | null): Promise<LockResponse> {
    return this.json(await this.request("DELETE", "/lock", { body: { note: note ?? null }, mutating: true }));
  }

  async exec(
    req: { command: string; timeout_ms?: number; cwd?: string; generation?: number; actor?: string },
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ExecResponse> {
    return this.json(await this.request("POST", "/exec", { body: req, timeoutMs, mutating: true, signal }), true);
  }

  async getFile(path: string, timeoutMs = 120_000): Promise<Buffer> {
    const res = await this.request("GET", `/files?path=${encodeURIComponent(path)}`, { timeoutMs });
    return Buffer.from(await res.arrayBuffer());
  }

  async getFileStream(path: string, timeoutMs = 600_000): Promise<Response> {
    return this.request("GET", `/files?path=${encodeURIComponent(path)}`, { timeoutMs });
  }

  async putFile(path: string, data: Uint8Array, timeoutMs = 120_000): Promise<{ bytes: number }> {
    return this.json(await this.request("PUT", `/files?path=${encodeURIComponent(path)}`, { raw: data, timeoutMs, mutating: true }), true);
  }

  async uiTree(window?: string, timeoutMs = 30_000): Promise<unknown> {
    const q = window ? `?window=${encodeURIComponent(window)}` : "";
    return this.json(await this.request("GET", `/ui-tree${q}`, { timeoutMs }));
  }

  async quiesce(timeoutMs = 60_000): Promise<unknown> {
    return this.json(await this.request("POST", "/quiesce", { body: {}, timeoutMs, mutating: true }), true);
  }

  /** Websocket URL for the daemon's /vnc route (send authHeader as Authorization). */
  vncUrl(mode: "view" | "control", generation?: number): string {
    const q = new URLSearchParams({ mode });
    if (generation !== undefined) q.set("generation", String(generation));
    return this.baseUrl.replace(/^http/, "ws") + `/vnc?${q}`;
  }
}

export type { UiNodeT };
