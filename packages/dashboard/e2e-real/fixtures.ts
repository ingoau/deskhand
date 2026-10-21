import { test as base, expect, type Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const MANAGER = process.env.E2E_URL!;
export const RUNTIME = (process.env.E2E_RUNTIME ?? "fake") as "fake" | "docker";
export const DOCKER = RUNTIME === "docker";
/** How long an agent input waits for the lock before `locked_by_user` (fake: DESKHAND_FAKE_LOCK_WAIT_MS; daemon: 30 s). */
export const LOCK_WAIT_MS = DOCKER ? 30_000 : 4_000;

/** Manager API call with the admin credential (like the CLI). */
export async function api<T = any>(method: string, p: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${MANAGER}${p}`, {
    method,
    headers: { authorization: `Bearer ${process.env.E2E_ADMIN_TOKEN}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get("content-type") ?? "";
  const data = ct.includes("json") ? await res.json() : res.status === 204 ? undefined : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data: data as T };
}

export interface ToolResult {
  text: string;
  images: number;
  isError: boolean;
}

/** An MCP client acting as the agent, with the e2e agent token. */
export class Agent {
  readonly desktops: string[] = [];
  private constructor(
    readonly client: Client,
    private readonly transport: StreamableHTTPClientTransport,
  ) {}

  static async connect(name: string): Promise<Agent> {
    const transport = new StreamableHTTPClientTransport(new URL(`${MANAGER}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${process.env.E2E_AGENT_TOKEN}` } },
    });
    const client = new Client({ name, version: "1.0.0" });
    await client.connect(transport);
    return new Agent(client, transport);
  }

  async call(name: string, args: Record<string, unknown> = {}, timeout = 120_000): Promise<ToolResult> {
    const r = (await this.client.callTool({ name, arguments: args }, undefined, { timeout, resetTimeoutOnProgress: true })) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const content = r.content ?? [];
    return {
      text: content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n"),
      images: content.filter((c) => c.type === "image").length,
      isError: !!r.isError,
    };
  }

  /** desktop_start; returns the desktop id. */
  async start(name: string): Promise<string> {
    const r = await this.call("desktop_start", { name });
    const id = /Desktop (\w+) is ready/.exec(r.text)?.[1];
    if (!id) throw new Error(`desktop_start failed: ${r.text}`);
    this.desktops.push(id);
    return id;
  }

  /** Runs a shell command in the desktop (as the agent) and returns stdout. */
  async exec(command: string, desktop?: string): Promise<string> {
    const r = await this.call("desktop_exec", { command, ...(desktop ? { desktop } : {}) });
    if (r.isError) throw new Error(`desktop_exec failed: ${r.text}`);
    return r.text;
  }

  async close() {
    await this.transport.terminateSession().catch(() => undefined);
    await this.client.close().catch(() => undefined);
  }
}

/** Opens a one-time login link (like `deskhand login-link`) so the page has a session cookie. */
export async function login(page: Page, path = "") {
  const r = await api<{ url: string }>("POST", "/api/login-links");
  expect(r.status).toBe(200);
  await page.goto(r.data.url);
  await expect(page).toHaveURL(/\/deskhand\/?(\?.*)?$/);
  if (path) await page.goto(path);
}

export async function waitRunning(id: string, timeout = DOCKER ? 90_000 : 10_000) {
  await expect
    .poll(async () => (await api<{ status: string }>("GET", `/api/desktops/${id}`)).data.status, { timeout, intervals: [250, 500, 1000] })
    .toBe("running");
}

export const test = base.extend<{ agent: (name?: string) => Promise<Agent>; mobile: boolean }>({
  mobile: async ({}, use, info) => use(info.project.name === "mobile"),
  agent: async ({}, use) => {
    const agents: Agent[] = [];
    await use(async (name = "e2e-agent") => {
      const a = await Agent.connect(name);
      agents.push(a);
      return a;
    });
    for (const a of agents) await a.close();
  },
  page: async ({ page }, use) => {
    await use(page);
    // Every test starts from an empty manager: remove whatever it created.
    const { data } = await api<{ desktops: Array<{ id: string }> }>("GET", "/api/desktops");
    await Promise.all(data.desktops.map((d) => api("DELETE", `/api/desktops/${d.id}`)));
  },
});

export { expect };

/**
 * Where the desktop's pointer is. Docker: `xdotool getmouselocation` inside the desktop (run by the agent, so
 * only while nobody holds the lock). Fake: the fake daemon's cursor (moved only by input that got through).
 */
export async function pointerAt(a: Agent, id: string): Promise<[number, number]> {
  if (DOCKER) {
    const out = await a.exec("xdotool getmouselocation", id);
    const m = /x:(\d+) y:(\d+)/.exec(out);
    if (!m) throw new Error(`unexpected getmouselocation output: ${out}`);
    return [Number(m[1]), Number(m[2])];
  }
  return (await api<{ cursor: [number, number] }>("GET", `/api/desktops/${id}/fake-inputs`)).data.cursor;
}

/** Fake runtime only: RFB client messages that reached the fake desktop (after the VNC input filter). */
export async function fakeVncInputs(id: string): Promise<Array<{ type: number; hex: string }>> {
  return (await api<{ vnc: Array<{ type: number; hex: string }> }>("GET", `/api/desktops/${id}/fake-inputs`)).data.vnc;
}

/**
 * Speaks raw RFB over `api/desktops/:id/vnc?<query>` from inside the page (same origin, session cookie) — a client
 * that ignores view-only — and sends a click at (x, y) plus a key press. Resolves when done or when the server
 * closes the connection. Used to prove the daemon itself drops input on view and stale control connections.
 */
export async function injectRfb(page: Page, id: string, query: string, x: number, y: number): Promise<{ handshake: boolean; closedCode: number | null }> {
  return page.evaluate(
    async ({ path, x, y }) => {
      const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`;
      const ws = new WebSocket(url, ["binary"]);
      ws.binaryType = "arraybuffer";
      let buf = new Uint8Array(0);
      let stage = 0;
      let handshake = false;
      return await new Promise<{ handshake: boolean; closedCode: number | null }>((resolve) => {
        const done = (closedCode: number | null) => {
          try {
            ws.close();
          } catch {
            /* closed */
          }
          resolve({ handshake, closedCode });
        };
        const pointer = (mask: number) => new Uint8Array([5, mask, x >> 8, x & 255, y >> 8, y & 255]);
        ws.onclose = (e) => done(e.code);
        ws.onerror = () => done(-1);
        ws.onmessage = (e) => {
          const add = new Uint8Array(e.data as ArrayBuffer);
          const n = new Uint8Array(buf.length + add.length);
          n.set(buf);
          n.set(add, buf.length);
          buf = n;
          for (;;) {
            if (stage === 0 && buf.length >= 12) {
              buf = buf.slice(12);
              ws.send(new TextEncoder().encode("RFB 003.008\n"));
              stage = 1;
            } else if (stage === 1 && buf.length >= 1 && buf.length >= 1 + buf[0]!) {
              buf = buf.slice(1 + buf[0]!);
              ws.send(new Uint8Array([1])); // security None
              stage = 2;
            } else if (stage === 2 && buf.length >= 4) {
              buf = buf.slice(4);
              ws.send(new Uint8Array([1])); // ClientInit, shared
              stage = 3;
            } else if (stage === 3 && buf.length >= 24) {
              const nameLen = new DataView(buf.buffer, buf.byteOffset).getUint32(20);
              if (buf.length < 24 + nameLen) return;
              buf = new Uint8Array(0);
              stage = 4;
              handshake = true;
              ws.send(pointer(0));
              ws.send(pointer(1));
              ws.send(pointer(0));
              ws.send(new Uint8Array([4, 1, 0, 0, 0, 0, 0, 0x61])); // 'a' down
              ws.send(new Uint8Array([4, 0, 0, 0, 0, 0, 0, 0x61])); // 'a' up
              setTimeout(() => done(null), 1500);
              return;
            } else return;
          }
        };
        setTimeout(() => done(null), 15_000);
      });
    },
    { path: `${new URL(MANAGER).pathname}/api/desktops/${id}/vnc?${query}`, x, y },
  );
}

/** True when p is within `tol` screen pixels of (x, y) on both axes (the live view is scaled, so clicks round). */
export function near(p: readonly [number, number], x: number, y: number, tol = 3): boolean {
  return Math.abs(p[0] - x) <= tol && Math.abs(p[1] - y) <= tol;
}

/** The noVNC canvas inside the live view. */
export const liveCanvas = (page: Page) => page.getByTestId("live-view").locator("canvas");

/** Waits until the live view is connected in the given mode. */
export async function liveConnected(page: Page, mode: "view" | "control") {
  const lv = page.getByTestId("live-view");
  await expect(lv).toHaveAttribute("data-live-mode", mode);
  await expect(lv).toHaveAttribute("data-live-state", "connected", { timeout: DOCKER ? 30_000 : 10_000 });
}

/** Clicks the live view at desktop-screen coordinates (x, y), mapping through the scaled canvas. */
export async function clickScreen(page: Page, x: number, y: number, screen = { width: 1280, height: 800 }, opts: { tap?: boolean } = {}) {
  const box = (await liveCanvas(page).boundingBox())!;
  const px = box.x + (x / screen.width) * box.width;
  const py = box.y + (y / screen.height) * box.height;
  if (opts.tap) await page.touchscreen.tap(px, py);
  else await page.mouse.click(px, py);
}
