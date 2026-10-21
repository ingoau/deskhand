/** Composition root: wires config, DB, runtime, services, MCP and the HTTP server. */
import path from "node:path";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import multipart from "@fastify/multipart";
import { pino, type Logger } from "pino";
import { ZodError } from "zod";
import { DeskhandError, ERROR_MESSAGES } from "@deskhand/shared";
import { McpService, registerBrowserTools, type BrowserProvider } from "@deskhand/mcp";
import type { Config } from "./config.js";
import { openDb, type DB } from "./db.js";
import { AuthService, type Principal } from "./auth.js";
import { ActionLog } from "./actionlog.js";
import { MountPolicy } from "./mounts.js";
import { DesktopService } from "./desktops.js";
import { TemplateService } from "./templates.js";
import { TemplateRebuilder } from "./template-ops.js";
import { FileService, ManagerMcpBackend } from "./mcp-backend.js";
import type { Runtime } from "./runtime/types.js";
import { DockerRuntime } from "./runtime/docker.js";
import { FakeRuntime } from "./runtime/fake.js";
import { registerRoutes } from "./routes.js";
import { registerStatic } from "./static.js";
import { PlaywrightBrowsers, listPlaywrightTools } from "./browser.js";

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export interface ManagerDeps {
  runtime?: Runtime;
  logger?: Logger;
  db?: DB;
  /** Replaces the Playwright-backed browser provider (tests). */
  browser?: BrowserProvider;
}

export interface Manager {
  cfg: Config;
  app: FastifyInstance;
  db: DB;
  runtime: Runtime;
  auth: AuthService;
  desktops: DesktopService;
  templates: TemplateService;
  rebuilder: TemplateRebuilder;
  actionLog: ActionLog;
  mcp: McpService;
  backend: ManagerMcpBackend;
  /** The Playwright MCP connections behind browser_* (null when DESKHAND_BROWSER_TOOLS=off or a test provider is used). */
  browsers: PlaywrightBrowsers | null;
  logger: Logger;
  /** Origin used for printed links, e.g. http://127.0.0.1:7480 */
  publicOrigin(): string;
  listen(): Promise<string>;
  close(): Promise<void>;
}

export async function createManager(cfg: Config, deps: ManagerDeps = {}): Promise<Manager> {
  const logger = deps.logger ?? pino({ level: cfg.logLevel, base: { svc: "deskhand" } });
  const db = deps.db ?? openDb(path.join(cfg.dataDir, "deskhand.db"));
  const runtime: Runtime = deps.runtime ?? (cfg.runtime === "fake" ? new FakeRuntime() : new DockerRuntime(cfg, logger));
  if (runtime instanceof FakeRuntime) runtime.images.add(cfg.desktopImage);
  const auth = new AuthService(db, { enabled: cfg.auth, dataDir: cfg.dataDir, basePath: cfg.basePath, trustProxy: cfg.trustProxy, publicUrl: cfg.publicUrl });
  const actionLog = new ActionLog(db, path.join(cfg.dataDir, "shots"), logger);
  const policy = new MountPolicy(cfg, runtime);
  const templates = new TemplateService(cfg, db, runtime, logger);
  const desktops = new DesktopService(cfg, db, runtime, policy, templates, actionLog, logger);
  templates.inUse = (name, version) => desktops.list().filter((d) => d.template === name && d.templateVersion === version).length;
  const files = new FileService(cfg, runtime, policy, desktops);
  const backend = new ManagerMcpBackend(cfg, db, auth, desktops, templates, actionLog, files, logger, runtime);
  const rebuilder = new TemplateRebuilder({ cfg, desktops, templates, runtime, log: logger });
  desktops.on("removed", (id: string) => {
    // A version kept only because a desktop used it can go now.
    const d = desktops.getAny(id);
    if (d) void templates.prune(d.template).catch(() => undefined);
  });
  const mcp = new McpService(backend, { sessionTimeoutMs: cfg.sessionTimeoutMs, sweepIntervalMs: Math.min(30_000, cfg.sweepIntervalMs), logger });
  let browsers: PlaywrightBrowsers | null = null;
  if (cfg.browserTools) {
    const provider = deps.browser ?? (browsers = new PlaywrightBrowsers(cfg, desktops, logger));
    const upstream = await listPlaywrightTools(path.join(cfg.dataDir, "playwright"));
    registerBrowserTools(mcp.registry, upstream, provider, { lockWaitMs: cfg.lockWaitMs });
  }

  const app = Fastify({
    loggerInstance: logger,
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: cfg.trustProxy,
    bodyLimit: 8 * 1024 * 1024,
    routerOptions: { ignoreTrailingSlash: true },
  }) as unknown as FastifyInstance;

  app.setErrorHandler((err: Error, req, reply) => {
    let e: DeskhandError;
    if (err instanceof DeskhandError) e = err;
    else if (err instanceof ZodError) e = new DeskhandError("invalid_argument", err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
    else if ((err as { validation?: unknown }).validation || (err as { statusCode?: number }).statusCode === 400) e = new DeskhandError("invalid_argument", err.message);
    else if ((err as { statusCode?: number }).statusCode === 413) e = new DeskhandError("invalid_argument", "The request body is too large.");
    else if ((err as { statusCode?: number }).statusCode === 404) e = new DeskhandError("not_found");
    else {
      req.log.error({ err }, "unhandled error");
      e = new DeskhandError("internal", ERROR_MESSAGES.internal);
    }
    if (e.code === "internal" && !(err instanceof DeskhandError)) req.log.error({ err: err.message, url: req.url }, "request failed");
    void reply.status(e.status).send(e.toJSON());
  });
  app.setNotFoundHandler((_req, reply) => void reply.status(404).send(new DeskhandError("not_found").toJSON()));

  await app.register(cookie);
  await app.register(websocket, {
    options: {
      maxPayload: 64 * 1024 * 1024,
      handleProtocols: (protocols: Set<string>) => (protocols.has("binary") ? "binary" : (protocols.values().next().value ?? false)),
    },
  });
  await app.register(multipart, { limits: { fileSize: cfg.fileMaxBytes, files: 1, fields: 10 } });

  let origin = "";
  const publicOrigin = () => {
    if (cfg.publicUrl) return new URL(cfg.publicUrl).origin;
    if (origin) return origin;
    const host = cfg.bind.host === "0.0.0.0" || cfg.bind.host === "::" ? "127.0.0.1" : cfg.bind.host.includes(":") ? `[${cfg.bind.host}]` : cfg.bind.host;
    return `http://${host}:${cfg.bind.port}`;
  };

  if (cfg.basePath) {
    // `${base}` without the trailing slash -> `${base}/` (ignoreTrailingSlash would otherwise treat them alike).
    app.addHook("onRequest", async (req, reply) => {
      const [p, q] = req.url.split("?");
      if (p === cfg.basePath && (req.method === "GET" || req.method === "HEAD")) {
        void reply.redirect(`${cfg.basePath}/${q ? `?${q}` : ""}`, 308);
        return reply;
      }
    });
  }

  const ctx = { cfg, auth, desktops, templates, rebuilder, actionLog, files, mcp, backend, runtime, logger, publicOrigin: () => publicOrigin() };
  await app.register(
    async (scope) => {
      await registerRoutes(scope, ctx);
      await registerStatic(scope, cfg);
    },
    { prefix: cfg.basePath },
  );

  const manager: Manager = {
    cfg,
    app,
    db,
    runtime,
    auth,
    desktops,
    templates,
    rebuilder,
    actionLog,
    mcp,
    backend,
    browsers,
    logger,
    publicOrigin,
    async listen() {
      await desktops.init();
      // Base-image tracking: a new desktop image rebuilds recipe-backed templates (in the background).
      await templates.initBase();
      void templates.pruneAll();
      void rebuilder.autoRebuild();
      const address = await app.listen({ host: cfg.bind.host, port: cfg.bind.port });
      const port = (app.server.address() as { port: number }).port;
      const host = cfg.bind.host === "0.0.0.0" || cfg.bind.host === "::" ? "127.0.0.1" : cfg.bind.host;
      origin = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
      auth.writeAdminCredential(`${origin}${cfg.basePath}`);
      const first = auth.initFirstStart();
      if (first.firstStart && cfg.auth) {
        const { code } = auth.createLoginCode();
        logger.info({ loginUrl: auth.loginUrl(code, publicOrigin()) }, "dashboard login link (valid for 5 minutes, single use; `deskhand login-link` prints a new one)");
      }
      if (first.token) {
        logger.info(
          { tokenName: first.token.token.name, token: first.token.secret, mcp: `${publicOrigin()}${cfg.basePath}/mcp` },
          "first API token created (shown only once): claude mcp add --transport http deskhand <mcp> --header \"Authorization: Bearer <token>\"",
        );
      }
      if (!cfg.auth) logger.warn("DESKHAND_AUTH=off: the dashboard, API and MCP endpoint need no credentials");
      logger.info({ address, base: cfg.basePath || "/", runtime: runtime.kind }, "deskhand manager listening");
      return address;
    },
    async close() {
      await mcp.close();
      await browsers?.close();
      await desktops.close();
      await app.close();
      await actionLog.flush();
      await runtime.close();
      if (!deps.db) db.close();
    },
  };
  return manager;
}
