/**
 * The daemon's HTTP API (contract: packages/shared/src/daemon.ts). Plain node:http; every route
 * except GET /health requires `Authorization: Bearer <key>`.
 */
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { z } from "zod";
import {
  DAEMON_API_VERSION,
  DESKHAND_VERSION,
  DeskhandError,
  ExecRequest,
  InputRequest,
  LockRequest,
  ScreenshotQuery,
  UnlockRequest,
  type DaemonState,
} from "@deskhand/shared";
import { cdpPortOpen, handleCdpHttp, handleCdpUpgrade } from "./cdp.js";
import type { Desktop } from "./desktop.js";
import { runExec } from "./exec.js";
import { readFileTo, statFile, writeFileFrom } from "./files.js";
import { log } from "./log.js";
import { quiesce } from "./quiesce.js";
import { encodeFrame, parseRegion } from "./screenshot.js";
import { agentUser } from "./session.js";
import { uiTree } from "./uitree.js";
import { VncProxy } from "./vnc.js";

const MAX_JSON = 2 * 1024 * 1024;

export interface ServerOptions {
  desktop: Desktop;
  /** Returns the current key (read from /run/deskhand/key). */
  key: () => string | null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(s), "cache-control": "no-store" });
  res.end(s);
}

function sendError(res: ServerResponse, e: unknown): void {
  const err =
    e instanceof DeskhandError
      ? e
      : e instanceof z.ZodError
        ? new DeskhandError("invalid_argument", `Invalid request: ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`)
        : new DeskhandError("internal");
  if (!(e instanceof DeskhandError) && !(e instanceof z.ZodError)) log.error("unhandled error", { error: String((e as Error)?.stack ?? e) });
  if (res.headersSent) {
    res.destroy();
    return;
  }
  sendJson(res, err.status, err.toJSON());
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_JSON) throw new DeskhandError("invalid_argument", "Request body too large.");
    chunks.push(c as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new DeskhandError("invalid_argument", "Request body is not valid JSON.");
  }
}

export function checkAuth(header: string | undefined, key: string | null): boolean {
  if (!key) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!m) return false;
  const a = Buffer.from(m[1]!.trim());
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

function chromiumSandbox(): "on" | "off" | null {
  try {
    const f = `/run/user/${agentUser().uid}/deskhand-chromium-sandbox`;
    if (!existsSync(f)) return null;
    const v = readFileSync(f, "utf8").trim();
    return v === "on" ? "on" : v === "off" ? "off" : null;
  } catch {
    return null;
  }
}

export function createServer(opts: ServerOptions): http.Server {
  const { desktop } = opts;
  const control = desktop.control;
  const vnc = new VncProxy(control);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://daemon");
    const path = url.pathname;
    const method = req.method ?? "GET";
    try {
      if (path === "/health" && method === "GET") {
        return sendJson(res, 200, { ok: true, version: DESKHAND_VERSION, apiVersion: DAEMON_API_VERSION });
      }
      if (!checkAuth(req.headers.authorization, opts.key())) {
        throw new DeskhandError("unauthorized", "Missing or invalid daemon key.");
      }
      // ------------------------------------------------------------------ state
      if (path === "/state" && method === "GET") {
        let title: string | null = null;
        try {
          title = await (await desktop.x(1000)).activeWindowTitle();
        } catch {
          /* display down: report null */
        }
        const state: DaemonState & { chromiumSandbox: "on" | "off" | null; queueLength: number } = {
          version: DESKHAND_VERSION,
          apiVersion: DAEMON_API_VERSION,
          title,
          screen: desktop.screen,
          lock: control.lock,
          generation: control.generation,
          lastHandback: control.lastHandback,
          lastAction: desktop.lastAction,
          uptimeSec: desktop.uptimeSec(),
          heldButtons: desktop.heldButtons(),
          cdpAvailable: await cdpPortOpen(),
          chromiumSandbox: chromiumSandbox(),
          queueLength: control.queueLength,
        };
        return sendJson(res, 200, state);
      }
      // ------------------------------------------------------------------ screenshot
      if (path === "/screenshot" && method === "GET") {
        const q = ScreenshotQuery.parse(Object.fromEntries(url.searchParams));
        const frame = await desktop.capture();
        const region = parseRegion(q.region, frame.width, frame.height);
        const e = await encodeFrame(frame, { format: q.format ?? "png", quality: q.quality, scale: q.scale, region });
        if (String(req.headers.accept ?? "").includes("application/json")) {
          return sendJson(res, 200, { mime: e.mime, data: e.data.toString("base64"), width: e.width, height: e.height });
        }
        res.writeHead(200, { "content-type": e.mime, "content-length": e.data.length, "cache-control": "no-store", "x-width": e.width, "x-height": e.height });
        return res.end(e.data);
      }
      // ------------------------------------------------------------------ input
      if (path === "/input" && method === "POST") {
        const body = InputRequest.parse(await readJson(req));
        return sendJson(res, 200, await desktop.perform(body));
      }
      if (path === "/cursor" && method === "GET") {
        const engine = await desktop.input();
        const [x, y] = await engine.cursor();
        return sendJson(res, 200, { x, y, cursor: [x, y] });
      }
      if (path === "/release-all" && method === "POST") {
        const released = await desktop.releaseAll();
        log.info("release-all", { released });
        return sendJson(res, 200, { released });
      }
      // ------------------------------------------------------------------ lock
      if (path === "/lock" && method === "POST") {
        const body = LockRequest.parse(await readJson(req));
        const r = control.takeLock(body.holder);
        log.info("lock taken", { holder: body.holder, generation: r.generation });
        return sendJson(res, 200, r);
      }
      if (path === "/lock" && method === "DELETE") {
        const body = UnlockRequest.parse(await readJson(req));
        const r = control.releaseLock(body.note);
        log.info("lock released", { generation: r.generation, note: body.note ?? null });
        return sendJson(res, 200, r);
      }
      // ------------------------------------------------------------------ exec
      if (path === "/exec" && method === "POST") {
        const body = ExecRequest.parse(await readJson(req));
        await control.checkAccess({ generation: body.generation, actor: body.actor });
        const t0 = performance.now();
        const r = await runExec({ command: body.command, timeoutMs: body.timeout_ms, cwd: body.cwd });
        log.info("exec", { actor: body.actor ?? null, ms: Math.round(performance.now() - t0), exitCode: r.exitCode, timedOut: r.timedOut });
        return sendJson(res, 200, r);
      }
      // ------------------------------------------------------------------ files
      if (path === "/files" && method === "GET") {
        const p = url.searchParams.get("path");
        const size = await statFile(p ?? "");
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": size, "cache-control": "no-store" });
        await readFileTo(p!, res);
        return res.end();
      }
      if (path === "/files" && method === "PUT") {
        const p = url.searchParams.get("path") ?? "";
        const bytes = await writeFileFrom(p, req);
        log.info("file written", { path: p, bytes });
        return sendJson(res, 200, { bytes });
      }
      // ------------------------------------------------------------------ ui tree
      if (path === "/ui-tree" && method === "GET") {
        return sendJson(res, 200, await uiTree(url.searchParams.get("window") ?? undefined));
      }
      // ------------------------------------------------------------------ quiesce
      if (path === "/quiesce" && method === "POST") {
        return sendJson(res, 200, await quiesce());
      }
      // ------------------------------------------------------------------ cdp (HTTP part)
      if (path === "/cdp" || path.startsWith("/cdp/")) {
        // Raw query: /json/new?<url> must reach Chromium unchanged.
        return await handleCdpHttp(req, res, path.slice(4) || "/json/version", url.search.slice(1));
      }
      sendJson(res, 404, { error: { code: "invalid_argument", message: `No route ${method} ${path}.` } });
    } catch (e) {
      sendError(res, e);
    }
  });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://daemon");
    const reject = (status: number, code: string, message: string) => {
      const body = JSON.stringify({ error: { code, message } });
      socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
    };
    socket.on("error", () => undefined);
    if (!checkAuth(req.headers.authorization, opts.key())) return reject(401, "unauthorized", "Missing or invalid daemon key.");
    if (url.pathname === "/vnc") return vnc.handleUpgrade(req, socket, head, url.searchParams);
    if (url.pathname.startsWith("/cdp/")) {
      handleCdpUpgrade(req, socket, head, url.pathname.slice(4), url.search.slice(1)).catch((e) => {
        const err = e instanceof DeskhandError ? e : new DeskhandError("internal");
        reject(err.status, err.code, err.message);
      });
      return;
    }
    reject(404, "invalid_argument", `No websocket route ${url.pathname}.`);
  });

  server.on("close", () => vnc.closeAll());
  server.requestTimeout = 0; // long input/exec calls carry their own deadlines
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
