import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createManager, type Manager } from "../src/app.js";
import { parseConfig } from "../src/config.js";
import { FakeRuntime } from "../src/runtime/fake.js";
import type { Runtime } from "../src/runtime/types.js";

/** Host ports reserved for these tests: 17200-17249 for managers (17250-17299 for fake daemons). */
export async function freePort(lo = 17200, hi = 17249): Promise<number> {
  const span = hi - lo + 1;
  const start = Math.floor(Math.random() * span);
  for (let i = 0; i < span; i++) {
    const port = lo + ((start + i) % span);
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.createServer();
      s.once("error", () => resolve(false));
      s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
    });
    if (ok) return port;
  }
  throw new Error("no free test port in range");
}

export function tmpDir(prefix = "deskhand-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export interface TestManager {
  m: Manager;
  url: string;
  base: string;
  token: string;
  runtime: Runtime;
  dataDir: string;
  close(opts?: { keepData?: boolean }): Promise<void>;
}

export const FAST_ENV: Record<string, string> = {
  DESKHAND_HEALTH_INTERVAL: "200ms",
  DESKHAND_SWEEP_INTERVAL: "200ms",
  DESKHAND_STATS_INTERVAL: "500ms",
  DESKHAND_START_TIMEOUT: "20s",
  DESKHAND_LOG_LEVEL: process.env.DESKHAND_TEST_LOG_LEVEL ?? "silent",
  DESKHAND_DASHBOARD_DIR: "",
};

export async function startManager(
  opts: { env?: Record<string, string>; runtime?: Runtime; dataDir?: string; fake?: ConstructorParameters<typeof FakeRuntime>[0] } = {},
): Promise<TestManager> {
  const dataDir = opts.dataDir ?? tmpDir();
  const docker = opts.env?.DESKHAND_RUNTIME === "docker";
  const runtime = opts.runtime ?? (docker ? undefined : new FakeRuntime({ lockWaitMs: 1000, ...opts.fake }));
  let m: Manager | undefined;
  let port = 0;
  let cfg: ReturnType<typeof parseConfig> | undefined;
  const env0: Record<string, string> = { ...FAST_ENV, DESKHAND_RUNTIME: "fake", DESKHAND_DATA_DIR: dataDir, ...opts.env };
  for (let attempt = 0; attempt < 20 && !m; attempt++) {
    // Test files run in parallel: another one may grab the port between the check and the bind.
    port = await freePort();
    cfg = parseConfig({ ...env0, DESKHAND_BIND: `127.0.0.1:${port}` });
    const candidate = await createManager(cfg, { runtime, logger: pino({ level: env0.DESKHAND_LOG_LEVEL }) });
    try {
      await candidate.listen();
      m = candidate;
    } catch (e) {
      await candidate.close().catch(() => undefined);
      if ((e as { code?: string }).code !== "EADDRINUSE") throw e;
    }
  }
  if (!m || !cfg) throw new Error("could not bind a test port");
  const token = m.auth.createToken(`test-${Math.random().toString(36).slice(2, 8)}`).secret;
  const base = cfg.basePath;
  const manager = m;
  return {
    m: manager,
    url: `http://127.0.0.1:${port}${base}`,
    base,
    token,
    runtime: manager.runtime,
    dataDir,
    async close(o = {}) {
      await manager.close();
      if (!o.keepData) fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export async function connectMcp(url: string, token: string, name = "test-client"): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

export function textOf(res: { content?: unknown }): string {
  return ((res.content as Array<{ type: string; text?: string }>) ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

export function imagesOf(res: { content?: unknown }): Array<{ data: string; mimeType: string }> {
  return ((res.content as Array<{ type: string; data?: string; mimeType?: string }>) ?? []).filter((c) => c.type === "image") as Array<{ data: string; mimeType: string }>;
}

export async function waitFor<T>(fn: () => T | Promise<T>, { timeout = 10_000, interval = 50, what = "condition" } = {}): Promise<T> {
  const end = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${(last as Error).message}` : ""}`);
}

export async function api(t: TestManager, method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${t.url}${p}`, {
    method,
    headers: { authorization: `Bearer ${t.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const ct = res.headers.get("content-type") ?? "";
  const data = ct.includes("json") ? await res.json() : await res.arrayBuffer();
  return { status: res.status, data: data as any, headers: res.headers };
}
