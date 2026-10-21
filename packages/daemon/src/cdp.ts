/**
 * /cdp/*: authenticated proxy to Chromium's remote-debugging port (127.0.0.1:9222 inside the
 * container). HTTP endpoints (/cdp/json/version, /cdp/json/list, /cdp/json/new …) are forwarded
 * with websocket URLs rewritten to point back through the daemon; websocket upgrades on
 * /cdp/devtools/* are piped raw. Chromium is launched on demand through deskhand-chromium.
 */
import { spawn } from "node:child_process";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { DeskhandError } from "@deskhand/shared";
import { log } from "./log.js";
import { isRunning } from "./procs.js";
import { agentUser, sessionEnv } from "./session.js";
import { sleep } from "./util.js";

export const CDP_PORT = Number(process.env.DESKHAND_CDP_PORT ?? 9222);
const CDP_HOST = "127.0.0.1";
export const CHROMIUM_WRAPPER = process.env.DESKHAND_CHROMIUM ?? "/usr/local/bin/deskhand-chromium";

/** Quick TCP probe of the debugging port. */
export function cdpPortOpen(timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(CDP_PORT, CDP_HOST);
    const t = setTimeout(() => {
      s.destroy();
      resolve(false);
    }, timeoutMs);
    s.once("connect", () => {
      clearTimeout(t);
      s.destroy();
      resolve(true);
    });
    s.once("error", () => {
      clearTimeout(t);
      resolve(false);
    });
  });
}

/** GET a path on the debugging port. */
export function cdpGet(path: string, method = "GET", timeoutMs = 3000): Promise<{ status: number; body: string; type: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: CDP_HOST, port: CDP_PORT, path, method, headers: { host: `${CDP_HOST}:${CDP_PORT}` }, timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 502, body, type: String(res.headers["content-type"] ?? "application/json") }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

/** Is a Chromium process running (with or without the debugging port)? */
function chromiumRunning(): boolean {
  return isRunning("chromium");
}

let launching: Promise<void> | null = null;

/** Start Chromium through the wrapper if the debugging port isn't up; wait until it is. */
export function ensureChromium(timeoutMs = 20_000): Promise<void> {
  if (launching) return launching;
  launching = (async () => {
    if (await cdpPortOpen()) return;
    if (!chromiumRunning()) {
      const u = agentUser();
      const isRoot = process.getuid?.() === 0;
      log.info("launching chromium for CDP");
      const child = spawn(CHROMIUM_WRAPPER, ["about:blank"], {
        env: sessionEnv(),
        cwd: u.home,
        detached: true,
        stdio: "ignore",
        ...(isRoot ? { uid: u.uid, gid: u.gid } : {}),
      });
      child.on("error", (e) => log.error("chromium launch failed", { error: e.message }));
      child.unref();
    }
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await cdpPortOpen()) {
        // The port opens slightly before /json/version answers.
        try {
          const r = await cdpGet("/json/version", "GET", 1000);
          if (r.status === 200) return;
        } catch {
          /* not yet */
        }
      }
      await sleep(150);
    }
    if (chromiumRunning()) {
      throw new DeskhandError(
        "daemon_unavailable",
        "Chromium is running without remote debugging (it was started without deskhand-chromium). Close it, then try again.",
      );
    }
    throw new DeskhandError("daemon_unavailable", "Chromium did not start within 20 s.");
  })().finally(() => {
    launching = null;
  });
  return launching;
}

/** Base URL (ws[s]://host/prefix/cdp) that rewritten websocket URLs should use. */
export function publicCdpBase(req: IncomingMessage): { ws: string; hostPath: string } {
  const h = req.headers;
  const host = String(h["x-forwarded-host"] ?? h.host ?? `127.0.0.1:${process.env.DESKHAND_DAEMON_PORT ?? 7000}`).split(",")[0]!.trim();
  const prefix = String(h["x-forwarded-prefix"] ?? "").replace(/\/+$/, "");
  const proto = String(h["x-forwarded-proto"] ?? "http").split(",")[0]!.trim();
  const scheme = proto === "https" || proto === "wss" ? "wss" : "ws";
  const hostPath = `${host}${prefix}/cdp`;
  return { ws: `${scheme}://${hostPath}`, hostPath };
}

/** Rewrite every reference to the local debugging port in a /json response. */
export function rewriteCdpBody(body: string, base: { ws: string; hostPath: string }): string {
  return body
    .replaceAll(`ws://${CDP_HOST}:${CDP_PORT}/`, `${base.ws}/`)
    .replaceAll(`ws://localhost:${CDP_PORT}/`, `${base.ws}/`)
    .replaceAll(`ws=${CDP_HOST}:${CDP_PORT}/`, `ws=${base.hostPath}/`)
    .replaceAll(`ws=localhost:${CDP_PORT}/`, `ws=${base.hostPath}/`);
}

/** HTTP part of the proxy: GET/PUT /cdp/json/... */
export async function handleCdpHttp(req: IncomingMessage, res: ServerResponse, subpath: string, query: string): Promise<void> {
  if (!subpath.startsWith("/json")) throw new DeskhandError("invalid_argument", "Only /cdp/json/* and websocket /cdp/devtools/* are proxied.");
  await ensureChromium();
  const method = req.method === "PUT" ? "PUT" : "GET";
  const r = await cdpGet(subpath + (query ? `?${query}` : ""), method, 5000);
  const body = rewriteCdpBody(r.body, publicCdpBase(req));
  res.writeHead(r.status, { "content-type": r.type, "cache-control": "no-store" });
  res.end(body);
}

/** Websocket part: pipe the upgraded socket to Chromium with Host rewritten. */
export async function handleCdpUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, subpath: string, query: string): Promise<void> {
  await ensureChromium();
  const upstream = net.connect(CDP_PORT, CDP_HOST);
  upstream.setNoDelay(true);
  const fail = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.once("error", fail);
  socket.once("error", fail);
  upstream.once("connect", () => {
    let raw = `${req.method ?? "GET"} ${subpath}${query ? `?${query}` : ""} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i]!;
      const lk = k.toLowerCase();
      if (lk === "authorization" || lk === "origin" || lk.startsWith("x-forwarded-")) continue;
      raw += `${k}: ${lk === "host" ? `${CDP_HOST}:${CDP_PORT}` : req.rawHeaders[i + 1]}\r\n`;
    }
    upstream.write(raw + "\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  socket.once("close", () => upstream.destroy());
  upstream.once("close", () => socket.destroy());
}

/** Close the browser through CDP (Browser.close) so cookies and session state are flushed. */
export async function closeBrowserViaCdp(timeoutMs = 10_000): Promise<boolean> {
  if (!(await cdpPortOpen())) return false;
  const v = await cdpGet("/json/version", "GET", 2000);
  const url = (JSON.parse(v.body) as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl;
  if (!url) return false;
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve();
    }, 3000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    ws.onmessage = () => undefined;
    ws.onclose = () => {
      clearTimeout(t);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(t);
      resolve();
    };
  });
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!chromiumRunning()) return true;
    await sleep(200);
  }
  return !chromiumRunning();
}

export { chromiumRunning };
