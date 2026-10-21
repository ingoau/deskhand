/**
 * browser_* tools, manager side: @playwright/mcp embedded as a library (plan: "How browser tools plug in").
 *
 * - One Playwright MCP connection per desktop, created on the first browser_* call and kept for the
 *   desktop's lifetime (so refs from browser_snapshot stay valid); disposed when the desktop stops, is
 *   removed or restarts, and recreated (with a note) if Chromium was closed or crashed.
 * - Playwright attaches to the desktop's own Chromium through the daemon's authenticated /cdp proxy
 *   (the daemon launches Chromium on demand). We connect playwright-core ourselves and hand the default
 *   context to createConnection(config, contextGetter), so we can see the pages too.
 * - Foreground tab: attached to an existing browser, Playwright MCP's "current" tab is the first page,
 *   which may be a background tab (clicks then hang waiting for "stable", spike finding). Before every
 *   call we find the tab the user actually sees (document.visibilityState / hasFocus) and select it with
 *   browser_tabs if Playwright MCP's current tab is a different one.
 * - File paths: browser_file_upload's `paths` are desktop paths; the files are fetched through the daemon
 *   (as the agent user) into a temp dir on the manager for the duration of the call. `filename`
 *   parameters are stripped from every schema (they would write to the manager's filesystem).
 * - Calls are serialised per desktop.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { createConnection } from "@playwright/mcp";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DeskhandError } from "@deskhand/shared";
import type { BrowserCallResult, BrowserProvider, Content, ResolvedDesktop, UpstreamTool } from "@deskhand/mcp";
import type { Config } from "./config.js";
import type { DesktopService } from "./desktops.js";

export const PLAYWRIGHT_MCP_VERSION = "0.0.83";

type McpServer = Awaited<ReturnType<typeof createConnection>>;

/** Playwright MCP config shared by the tool listing and every desktop connection. */
function pwConfig(outputDir: string): Parameters<typeof createConnection>[0] {
  return {
    browser: { browserName: "chromium", isolated: false },
    // Page-registered WebMCP tools would be an injection vector and can't be re-exported statically.
    webmcp: false,
    outputDir,
    // file:// URLs open files inside the desktop (Chromium runs there). Manager-side file access is
    // closed off separately: `filename` params are stripped and upload paths are rewritten by us.
    allowUnrestrictedFileAccess: true,
    imageResponses: "allow",
    codegen: "none",
    // Action tools would write their page snapshot to a file on the manager and return only a link
    // the agent cannot open; agents call browser_snapshot (inline) when they need refs instead.
    snapshot: { mode: "none" },
  };
}

async function linkedClient(server: McpServer): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "deskhand", version: PLAYWRIGHT_MCP_VERSION });
  await client.connect(b);
  return client;
}

/** Lists Playwright MCP's tools without touching a browser (the context getter is never called). */
export async function listPlaywrightTools(outputDir: string): Promise<UpstreamTool[]> {
  const server = await createConnection(pwConfig(outputDir), async () => {
    throw new Error("listing only");
  });
  const client = await linkedClient(server);
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown>, annotations: t.annotations as UpstreamTool["annotations"] }));
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

interface Conn {
  key: string;
  browser: Browser;
  context: BrowserContext;
  server: McpServer;
  client: Client;
  /** The page we last made Playwright MCP's current tab (null = unknown). */
  current: Page | null;
  dead: boolean;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      () => (clearTimeout(t), resolve(null)),
    );
  });
}

/**
 * Playwright MCP appends console messages to a log file in its output dir (on the manager) and points
 * at it ("- New console entries: <path>#L1-L3"); the agent cannot open that file, so point it at the
 * tool that returns them instead. The only rewrite of forwarded results.
 */
export function localizeLinks(c: Content): Content {
  if (c.type !== "text" || !c.text.includes("New console entries:")) return c;
  return { ...c, text: c.text.replace(/^- New console entries: .*$/gm, "- New console messages: call browser_console_messages to read them") };
}

const RECONNECT_NOTE =
  "Chromium was closed or restarted since your last browser_* call, so element refs from earlier snapshots are gone; take a new browser_snapshot.";

export class PlaywrightBrowsers implements BrowserProvider {
  private readonly conns = new Map<string, Promise<Conn>>();
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Desktops that had a connection that died (Chromium closed): the next call gets RECONNECT_NOTE. */
  private readonly lost = new Set<string>();
  private readonly onGone = (id: string) => void this.dispose(id, false);
  private closed = false;

  constructor(
    private readonly cfg: Config,
    private readonly desktops: DesktopService,
    private readonly log: Logger,
  ) {
    desktops.on("stopped", this.onGone);
    desktops.on("removed", this.onGone);
  }

  get outputRoot(): string {
    return path.join(this.cfg.dataDir, "playwright");
  }

  /** Desktop ids with an open connection (tests, debugging). */
  connected(): string[] {
    return [...this.conns.keys()];
  }

  private keyFor(rd: ResolvedDesktop): string {
    const d = this.desktops.getAny(rd.desktop.id);
    return `${rd.daemon.baseUrl}|${d?.startedAt ?? ""}|${d?.containerId ?? ""}`;
  }

  async call(rd: ResolvedDesktop, tool: string, args: Record<string, unknown>, opts: { signal: AbortSignal; timeoutMs: number; mutating: boolean }): Promise<BrowserCallResult> {
    const id = rd.desktop.id;
    const prev = this.queues.get(id) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => this.callNow(rd, tool, args, opts));
    this.queues.set(id, run);
    try {
      return await run;
    } finally {
      if (this.queues.get(id) === run) this.queues.delete(id);
    }
  }

  private async callNow(rd: ResolvedDesktop, tool: string, args: Record<string, unknown>, opts: { signal: AbortSignal; timeoutMs: number; mutating: boolean }): Promise<BrowserCallResult> {
    if (this.closed) throw new DeskhandError("daemon_unavailable", "deskhand is shutting down.");
    const id = rd.desktop.id;
    const notes: string[] = [];
    const conn = await this.get(rd, notes);
    if (tool !== "browser_handle_dialog") await this.selectForeground(conn).catch((e) => this.log.debug({ desktop: id, err: (e as Error).message }, "foreground tab sync failed"));

    let uploadDir: string | null = null;
    try {
      if (tool === "browser_file_upload" && Array.isArray(args.paths)) {
        uploadDir = path.join(this.outputRoot, id, `upload-${randomBytes(6).toString("hex")}`);
        args = { ...args, paths: await this.stageUploads(rd, args.paths as unknown[], uploadDir) };
      }
      let res;
      try {
        res = await conn.client.callTool({ name: tool, arguments: args }, undefined, { signal: opts.signal, timeout: opts.timeoutMs });
      } catch (e) {
        // Timed out, cancelled or the in-process connection broke: the action may or may not have happened.
        this.log.warn({ desktop: id, tool, err: (e as Error).message }, "browser call failed; dropping the connection");
        void this.dispose(id, true);
        if (opts.mutating) throw new DeskhandError("outcome_unknown");
        throw new DeskhandError("timeout", "The browser did not answer in time; take a screenshot to check the desktop's state.");
      }
      if (tool === "browser_tabs") conn.current = null;
      if (conn.dead) {
        this.lost.add(id);
        void this.dispose(id, true);
      }
      return { content: ((res.content ?? []) as Content[]).map(localizeLinks), isError: !!res.isError, notes };
    } finally {
      if (uploadDir) fs.rmSync(uploadDir, { recursive: true, force: true });
    }
  }

  private async stageUploads(rd: ResolvedDesktop, paths: unknown[], dir: string): Promise<string[]> {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const out: string[] = [];
    for (const [i, p] of paths.entries()) {
      if (typeof p !== "string" || !p.startsWith("/")) throw new DeskhandError("invalid_argument", "browser_file_upload paths must be absolute paths inside the desktop.");
      const data = await rd.daemon.getFile(p).catch((e) => {
        if (e instanceof DeskhandError && (e.code === "not_found" || e.code === "forbidden")) {
          throw new DeskhandError(e.code, `Cannot read ${p} inside the desktop: ${e.message}`);
        }
        throw e;
      });
      if (data.length > this.cfg.fileMaxBytes) throw new DeskhandError("invalid_argument", `${p} is larger than the ${this.cfg.fileMaxBytes}-byte limit.`);
      const sub = path.join(dir, String(i));
      fs.mkdirSync(sub);
      const local = path.join(sub, path.posix.basename(p) || "file");
      fs.writeFileSync(local, data, { mode: 0o600 });
      out.push(local);
    }
    return out;
  }

  private async get(rd: ResolvedDesktop, notes: string[]): Promise<Conn> {
    const id = rd.desktop.id;
    const key = this.keyFor(rd);
    const existing = this.conns.get(id);
    if (existing) {
      const c = await existing.catch(() => null);
      if (c && !c.dead && c.key === key) return c;
      if (c && c.dead) this.lost.add(id);
      await this.dispose(id, c?.key === key);
    }
    if (this.lost.delete(id)) notes.push(RECONNECT_NOTE);
    const p = this.open(rd, key);
    this.conns.set(id, p);
    try {
      return await p;
    } catch (e) {
      if (this.conns.get(id) === p) this.conns.delete(id);
      if (e instanceof DeskhandError) throw e;
      this.log.warn({ desktop: id, err: (e as Error).message }, "could not attach Playwright to the desktop's Chromium");
      throw new DeskhandError("daemon_unavailable", "Could not connect to the desktop's Chromium; try again in a few seconds.");
    }
  }

  private async open(rd: ResolvedDesktop, key: string): Promise<Conn> {
    const id = rd.desktop.id;
    const endpoint = `${rd.daemon.baseUrl}/cdp`;
    const t0 = Date.now();
    // noDefaults: don't override download behaviour (downloads stay in the desktop's ~/Downloads) or
    // emulation on the user's existing pages.
    const browser = await chromium.connectOverCDP(endpoint, { headers: { authorization: rd.daemon.authHeader }, timeout: 30_000, noDefaults: true });
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close().catch(() => undefined);
      throw new DeskhandError("daemon_unavailable", "The desktop's Chromium has no browser window; try again.");
    }
    const outDir = path.join(this.outputRoot, id);
    fs.mkdirSync(outDir, { recursive: true });
    const server = await createConnection(pwConfig(outDir), async () => context);
    const client = await linkedClient(server);
    const conn: Conn = { key, browser, context, server, client, current: null, dead: false };
    browser.on("disconnected", () => {
      conn.dead = true;
    });
    context.on("page", () => {
      conn.current = null;
    });
    // Initialise Playwright MCP's tab list (browser_tabs select does not).
    await client.callTool({ name: "browser_tabs", arguments: { action: "list" } }, undefined, { timeout: 30_000 });
    this.log.info({ desktop: id, ms: Date.now() - t0, pages: context.pages().length }, "attached Playwright MCP to the desktop's Chromium");
    return conn;
  }

  /** Makes the tab the user sees Playwright MCP's current tab. */
  private async selectForeground(conn: Conn): Promise<void> {
    const pages = conn.context.pages();
    if (pages.length === 0) return;
    if (pages.length === 1) {
      conn.current = pages[0]!;
      return;
    }
    const vis = await Promise.all(pages.map((p) => withTimeout(p.evaluate(() => ({ v: document.visibilityState, f: document.hasFocus() })), 700)));
    let idx = vis.findIndex((v) => v?.v === "visible" && v.f);
    if (idx < 0) idx = vis.findIndex((v) => v?.v === "visible");
    if (idx < 0 || conn.current === pages[idx]) return;
    await conn.client.callTool({ name: "browser_tabs", arguments: { action: "select", index: idx } }, undefined, { timeout: 10_000 });
    conn.current = pages[idx]!;
  }

  /** Drops a desktop's connection (Chromium keeps running). `lost`: the agent's refs are gone, say so next time. */
  async dispose(id: string, lost: boolean): Promise<void> {
    const p = this.conns.get(id);
    if (!lost) this.lost.delete(id);
    if (!p) return;
    this.conns.delete(id);
    if (lost) this.lost.add(id);
    const c = await p.catch(() => null);
    if (!c) return;
    c.dead = true;
    await c.client.close().catch(() => undefined);
    await c.server.close().catch(() => undefined);
    // For a browser attached with connectOverCDP this only disconnects; Chromium keeps running.
    await c.browser.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.desktops.off("stopped", this.onGone);
    this.desktops.off("removed", this.onGone);
    await Promise.allSettled([...this.conns.keys()].map((id) => this.dispose(id, false)));
  }
}
