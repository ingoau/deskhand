/** HTTP API (packages/shared/src/manager.ts + manager-api.ts), auth routes, VNC proxy, MCP mount. */
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import WebSocket from "ws";
import {
  CreateDesktopRequest,
  CreateTokenRequest,
  DeskhandError,
  HandbackRequest,
  LoginRequest,
  RollbackRequest,
  SaveTemplateRequest,
  UpdateRecipeRequest,
  SetPersistentRequest,
  SetTitleRequest,
  type Me,
  type SystemSummary,
} from "@deskhand/shared";
import type { McpService } from "@deskhand/mcp";
import type { Logger } from "pino";
import { COOKIE_NAME, parseCookies, type AuthService, type Principal } from "./auth.js";
import type { Config } from "./config.js";
import type { DesktopService } from "./desktops.js";
import type { TemplateService } from "./templates.js";
import type { ActionLog } from "./actionlog.js";
import type { FileService, ManagerMcpBackend } from "./mcp-backend.js";
import { saveDesktopAsTemplate, type TemplateRebuilder } from "./template-ops.js";
import type { Runtime } from "./runtime/types.js";
import type { FakeRuntime } from "./runtime/fake.js";
import { toPng, toThumbnail } from "./images.js";
import { z } from "zod";

export interface RouteContext {
  cfg: Config;
  auth: AuthService;
  desktops: DesktopService;
  templates: TemplateService;
  rebuilder: TemplateRebuilder;
  actionLog: ActionLog;
  files: FileService;
  mcp: McpService;
  backend: ManagerMcpBackend;
  runtime: Runtime;
  logger: Logger;
  publicOrigin(): string;
}

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Decided on the matched route pattern, not the raw URL: the router matches the decoded path, so a raw-URL check
 * could be bypassed with percent-encoding (/%61pi/...). Unmatched URLs only reach the 404 handler.
 */
function isPublic(route: string | undefined, method: string): boolean {
  if (route === undefined) return true;
  if (route === "/healthz" || route === "/" || route === "/*") return true; // health, dashboard static files
  if (route === "/auth/login") return method === "GET" || method === "POST";
  return false;
}

/** Principal kinds allowed to manage credentials (not agent API tokens). */
function requireOperator(p: Principal | undefined) {
  if (!p || p.kind === "token" || (p.kind === "cookie" && p.via === "token")) throw new DeskhandError("forbidden", "Managing tokens and login links needs the deskhand CLI or a dashboard session from a login link (`deskhand login-link`), not an agent API token.");
}

export async function registerRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { cfg, auth, desktops, templates, actionLog } = ctx;
  const base = cfg.basePath;

  app.addHook("onRequest", async (req, reply) => {
    if (!auth.hostAllowed({ headers: req.headers })) {
      void reply.status(421).send(new DeskhandError("forbidden", "Unknown Host header; set DESKHAND_PUBLIC_URL or DESKHAND_ALLOWED_HOSTS to the name you reach deskhand by.").toJSON());
      return reply;
    }
    const route = req.routeOptions.url === undefined ? undefined : req.routeOptions.url.slice(base.length) || "/";
    const isWs = (req.headers.upgrade ?? "").toLowerCase() === "websocket";
    if (route === "/mcp") return; // the MCP service authenticates itself
    const pub = isPublic(route, req.method);
    const principal = pub ? undefined : auth.authenticate(req.headers);
    if (!pub && !principal) {
      void reply.status(401).header("www-authenticate", 'Bearer realm="deskhand"').send(new DeskhandError("unauthorized").toJSON());
      return reply;
    }
    req.principal = principal ?? undefined;
    if (STATE_CHANGING.has(req.method) || isWs) {
      const viaCookie = !req.headers.authorization && !!parseCookies(req.headers.cookie)[COOKIE_NAME];
      const ok = auth.originAllowed({ headers: req.headers, encrypted: (req.raw.socket as { encrypted?: boolean }).encrypted }, viaCookie || isWs);
      if (!ok) {
        void reply.status(403).send(new DeskhandError("forbidden", "Cross-origin request refused: this must come from the deskhand dashboard's own origin.").toJSON());
        return reply;
      }
    }
  });

  const actor = (req: FastifyRequest) => req.principal?.name ?? "anonymous";

  // ---------------------------------------------------------------- health, MCP

  app.get("/healthz", async () => {
    let docker = "ok";
    try {
      await ctx.runtime.ping();
    } catch {
      docker = "unavailable";
    }
    return { ok: true, version: cfg.version, docker };
  });

  app.route({
    method: ["GET", "POST", "DELETE"],
    url: "/mcp",
    handler: async (req, reply) => {
      reply.hijack();
      await ctx.mcp.handle(req.raw, reply.raw, req.body);
    },
  });

  // ---------------------------------------------------------------- auth

  const setSessionCookie = (req: FastifyRequest, reply: FastifyReply, value: string) => {
    void reply.setCookie(COOKIE_NAME, value, auth.sessionCookieOptions({ headers: req.headers, encrypted: (req.raw.socket as { encrypted?: boolean }).encrypted }));
  };
  const clearSessionCookie = (reply: FastifyReply) => void reply.clearCookie(COOKIE_NAME, { path: base || "/" });

  app.get("/auth/login", async (req, reply) => {
    const code = (req.query as { code?: string }).code;
    void reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    if (code && auth.consumeLoginCode(code)) {
      const s = auth.createWebSession("link");
      setSessionCookie(req, reply, s.value);
      return reply.redirect(`${base}/`, 303);
    }
    return reply.redirect(`${base}/?login=${code ? "expired" : "missing"}`, 303);
  });

  app.post("/auth/login", async (req, reply) => {
    const body = LoginRequest.parse(req.body ?? {});
    let ok = false;
    let tokenId: string | undefined;
    if (body.token) {
      tokenId = auth.verifyToken(body.token)?.id;
      ok = !!tokenId;
    } else if (body.code) ok = auth.consumeLoginCode(body.code);
    if (!ok) throw new DeskhandError("unauthorized", body.code ? "That login link has expired or was already used; run `deskhand login-link` for a new one." : "That API token is not valid.");
    const s = tokenId ? auth.createWebSession("token", tokenId) : auth.createWebSession("link");
    setSessionCookie(req, reply, s.value);
    return reply.status(204).send();
  });

  app.post("/auth/logout", async (req, reply) => {
    const c = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (c) auth.revokeWebSession(c);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.post("/auth/logout-all", async (req, reply) => {
    requireOperator(req.principal);
    auth.revokeAllWebSessions();
    clearSessionCookie(reply);
    return reply.status(204).send();
  });

  // ---------------------------------------------------------------- me, system, tokens, login links

  app.get("/api/me", async (req): Promise<Me> => {
    const p = req.principal!;
    const via = p.kind === "cookie" ? "cookie" : p.kind === "token" ? "token" : p.kind === "admin" ? "admin" : "none";
    return { auth: auth.enabled, via, actor: p.name, version: cfg.version, basePath: base };
  });

  app.get("/api/system", async (): Promise<SystemSummary> => {
    const u = desktops.systemUsage();
    return {
      version: cfg.version,
      running: u.running,
      maxDesktops: cfg.maxDesktops,
      cpuPercent: u.cpuPercent,
      memoryUsedBytes: u.memoryUsedBytes,
      memoryBudgetBytes: desktops.budgetBytes,
      logDiskBytes: actionLog.diskBytes(),
      auth: auth.enabled,
      warnings: desktops.warnings(),
      hardware: desktops.hardware.info(),
    };
  });

  app.get("/api/tokens", async (req) => {
    requireOperator(req.principal);
    return { tokens: auth.listTokens() };
  });

  app.post("/api/tokens", async (req, reply) => {
    requireOperator(req.principal);
    const { name } = CreateTokenRequest.parse(req.body ?? {});
    const r = auth.createToken(name);
    return reply.status(201).send({ token: r.token, secret: r.secret });
  });

  app.delete("/api/tokens/:id", async (req, reply) => {
    requireOperator(req.principal);
    const { id } = req.params as { id: string };
    if (!auth.revokeToken(id)) throw new DeskhandError("not_found", `No active token ${id}.`);
    return reply.status(204).send();
  });

  app.post("/api/login-links", async (req) => {
    requireOperator(req.principal);
    const { code, expiresAt } = auth.createLoginCode();
    return { url: auth.loginUrl(code, ctx.publicOrigin()), expiresAt };
  });

  // ---------------------------------------------------------------- desktops

  const D = "/api/desktops/:id";
  const did = (req: FastifyRequest) => (req.params as { id: string }).id;
  const summaryOf = (id: string) => desktops.summary(desktops.require(id));

  app.get("/api/desktops", async () => ({ desktops: desktops.list().map((d) => desktops.summary(d)) }));

  app.post("/api/desktops", async (req, reply) => {
    const body = CreateDesktopRequest.parse(req.body ?? {});
    // Respond as soon as the desktop is admitted (status "starting"); it finishes starting in the background.
    const inserted = new Promise<string>((resolve, reject) => {
      desktops
        .create({ sessionId: null, sessionLabel: null, ...body, actor: actor(req) }, undefined, { onInserted: resolve })
        .then((d) => actionLog.record({ desktopId: d.id, tool: "desktop_start", summary: `desktop_start ${d.template} (dashboard)`, outcome: "ok", actor: actor(req), session: null, args: body }))
        .catch(reject);
    });
    const id = await inserted;
    return reply.status(201).send(desktops.summary(desktops.getAny(id)!));
  });

  app.get(D, async (req) => summaryOf(did(req)));

  app.delete(D, async (req, reply) => {
    const id = did(req);
    desktops.require(id);
    await desktops.remove(id, "user");
    actionLog.record({ desktopId: id, tool: "remove", summary: "removed from the dashboard", outcome: "ok", actor: actor(req), session: null });
    return reply.status(204).send();
  });

  app.post(`${D}/stop`, async (req) => {
    const id = did(req);
    await desktops.stop(id, "user");
    actionLog.record({ desktopId: id, tool: "stop", summary: "stopped from the dashboard", outcome: "ok", actor: actor(req), session: null });
    return summaryOf(id);
  });

  app.post(`${D}/start`, async (req) => {
    const id = did(req);
    await desktops.ensureRunning(id);
    return summaryOf(id);
  });

  app.post(`${D}/persistent`, async (req) => {
    const { persistent } = SetPersistentRequest.parse(req.body ?? {});
    return desktops.summary(desktops.setPersistent(did(req), persistent));
  });

  app.post(`${D}/title`, async (req) => {
    const { title } = SetTitleRequest.parse(req.body ?? {});
    return desktops.summary(desktops.setTitle(did(req), title.trim() || null));
  });

  app.post(`${D}/lock`, async (req) => {
    const id = did(req);
    const d = desktops.require(id);
    const current = await desktops.refreshState(d);
    if (current?.lock) return { generation: current.generation, lock: current.lock }; // idempotent
    const st = await desktops.lock(id, "dashboard");
    const shot = await desktops.daemon(d).screenshotRaw({ format: "png" }).catch(() => null);
    actionLog.record({ desktopId: id, tool: "takeover", summary: "the user took over", outcome: "ok", actor: actor(req), session: null, screenshot: shot?.data ?? null });
    return { generation: st?.generation ?? 0, lock: st?.lock ?? null };
  });

  app.delete(`${D}/lock`, async (req) => {
    const id = did(req);
    const { note } = HandbackRequest.parse(req.body ?? {});
    const st = await desktops.unlock(id, note ?? null);
    const shot = await desktops.daemon(desktops.require(id)).screenshotRaw({ format: "png" }).catch(() => null);
    actionLog.record({
      desktopId: id,
      tool: "handback",
      summary: note ? `handed back: ${note.slice(0, 200)}` : "handed back",
      args: { note: note ?? null },
      outcome: "ok",
      actor: actor(req),
      session: null,
      screenshot: shot?.data ?? null,
    });
    return { generation: st?.generation ?? 0, lock: null };
  });

  app.delete(`${D}/attention`, async (req) => {
    const id = did(req);
    const { note } = HandbackRequest.parse(req.body ?? {});
    desktops.dismissAttention(id, note ?? null);
    return summaryOf(id);
  });

  // Thumbnails are cached briefly so many dashboard viewers cost one capture.
  const thumbCache = new Map<string, { at: number; width: number; data: Buffer }>();
  app.get(`${D}/thumbnail`, async (req, reply) => {
    const id = did(req);
    const d = desktops.require(id);
    const width = Math.min(Math.max(Number((req.query as { width?: string }).width ?? 320) || 320, 64), 1920);
    void reply.header("cache-control", "no-store");
    if (d.status !== "running") {
      const f = actionLog.latestScreenshotFile(id, true);
      if (!f) throw new DeskhandError("desktop_stopped", `Desktop ${id} is ${d.status}.`);
      return reply.type("image/webp").send(await fs.promises.readFile(f));
    }
    const c = thumbCache.get(id);
    if (c && c.width === width && Date.now() - c.at < 750) return reply.type("image/webp").send(c.data);
    const shot = await desktops.daemon(d).screenshotRaw({ format: "webp", scale: Math.min(1, width / d.screen.width), quality: 60 });
    const data = await toThumbnail(shot.data, shot.mime, width);
    thumbCache.set(id, { at: Date.now(), width, data });
    return reply.type("image/webp").send(data);
  });

  app.get(`${D}/screenshot`, async (req, reply) => {
    const d = desktops.require(did(req));
    const format = z.enum(["png", "webp", "jpeg"]).optional().parse((req.query as { format?: string }).format) ?? "png";
    const shot = await desktops.daemon(d).screenshotRaw({ format });
    const data = format === "png" ? await toPng(shot.data) : shot.data;
    return reply.header("cache-control", "no-store").type(format === "png" ? "image/png" : shot.mime).send(data);
  });

  app.get(`${D}/log`, async (req) => {
    const id = did(req);
    if (!desktops.getAny(id)) throw new DeskhandError("desktop_not_found");
    const q = req.query as { before?: string; limit?: string };
    return { entries: actionLog.list(id, { before: q.before ? Number(q.before) : undefined, limit: q.limit ? Number(q.limit) : undefined }) };
  });

  app.get("/api/log/:id/screenshot", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const thumb = ["1", "true"].includes(String((req.query as { thumb?: string }).thumb ?? ""));
    const f = Number.isInteger(id) ? actionLog.screenshotFile(id, thumb) : null;
    if (!f) throw new DeskhandError("not_found", "No screenshot stored for that log entry.");
    return reply.header("cache-control", "private, max-age=86400").type("image/webp").send(await fs.promises.readFile(f));
  });

  // Fake runtime only (tests, dashboard e2e): what reached the fake desktop, incl. VNC input that got through the filter.
  if (ctx.runtime.kind === "fake") {
    app.get(`${D}/fake-inputs`, async (req) => {
      const fake = (ctx.runtime as FakeRuntime).daemonFor(did(req));
      if (!fake) throw new DeskhandError("desktop_stopped");
      return {
        inputs: fake.inputs,
        vnc: fake.vncInputs.map((b) => ({ type: b[0], hex: b.toString("hex") })),
        cursor: fake.cursor,
      };
    });
  }

  // ---------------------------------------------------------------- files

  app.post(`${D}/files`, async (req) => {
    const d = desktops.require(did(req));
    let target: string | undefined;
    let data: Buffer | undefined;
    let filename: string | undefined;
    for await (const part of req.parts()) {
      if (part.type === "file") {
        filename = part.filename;
        data = await part.toBuffer();
      } else if (part.fieldname === "path") {
        target = String(part.value);
      }
    }
    if (!data) throw new DeskhandError("invalid_argument", "Send the file as multipart field `file`.");
    if (!target) target = `/home/agent/Downloads/${path.posix.basename(filename || "upload.bin")}`;
    else if (target.endsWith("/")) target += path.posix.basename(filename || "upload.bin");
    if (!target.startsWith("/")) throw new DeskhandError("invalid_argument", "path must be absolute.");
    const r = await desktops.daemon(d).putFile(target, data);
    actionLog.record({ desktopId: d.id, tool: "file_upload", summary: `uploaded ${target}`, args: { path: target, bytes: r.bytes }, outcome: "ok", actor: actor(req), session: null });
    return { path: target, bytes: r.bytes };
  });

  app.get(`${D}/files`, async (req, reply) => {
    const d = desktops.require(did(req));
    const p = (req.query as { path?: string }).path;
    if (!p || !p.startsWith("/")) throw new DeskhandError("invalid_argument", "Pass ?path=/absolute/path.");
    const res = await desktops.daemon(d).getFileStream(p);
    const name = path.posix.basename(p).replace(/["\\\r\n]/g, "_");
    void reply.header("content-disposition", `attachment; filename="${name}"`).type("application/octet-stream");
    const len = res.headers.get("content-length");
    if (len) void reply.header("content-length", len);
    return reply.send(Buffer.from(await res.arrayBuffer()));
  });

  // ---------------------------------------------------------------- templates

  app.post(`${D}/save-as-template`, async (req) => {
    const d = desktops.require(did(req));
    const body = SaveTemplateRequest.parse(req.body ?? {});
    const r = await saveDesktopAsTemplate({ cfg, desktops, templates, runtime: ctx.runtime, log: ctx.logger }, d, body, actor(req), false, "dashboard");
    return { template: r.template, version: r.version, notes: [...r.notes, ...r.manifest.notes] };
  });

  app.get("/api/templates", async () => ({ templates: templates.list() }));
  app.get("/api/templates/:name", async (req) => templates.info((req.params as { name: string }).name));
  app.delete("/api/templates/:name", async (req, reply) => {
    await templates.delete((req.params as { name: string }).name);
    return reply.status(204).send();
  });
  app.post("/api/templates/:name/rollback", async (req) => {
    const { version } = RollbackRequest.parse(req.body ?? {});
    const name = (req.params as { name: string }).name;
    templates.rollback(name, version);
    return templates.info(name);
  });
  app.post("/api/templates/:name/default", async (req) => {
    const name = (req.params as { name: string }).name;
    templates.setDefault(name);
    return templates.info(name);
  });
  app.put("/api/templates/:name/recipe", async (req) => {
    const { recipe } = UpdateRecipeRequest.parse(req.body ?? {});
    return templates.setRecipe((req.params as { name: string }).name, recipe);
  });
  app.post("/api/templates/:name/rebuild", async (req) => {
    const r = await ctx.rebuilder.rebuild((req.params as { name: string }).name, actor(req));
    return { template: r.template, version: r.version };
  });
  app.get("/api/templates/:name/diff", async (req) => {
    const q = req.query as { from?: string; to?: string };
    const num = (v: string | undefined) => (v === undefined || v === "" ? undefined : Number(v.replace(/^v/, "")));
    const from = num(q.from);
    const to = num(q.to);
    if ((from !== undefined && !Number.isInteger(from)) || (to !== undefined && !Number.isInteger(to))) throw new DeskhandError("invalid_argument", "from and to are version numbers.");
    return templates.diff((req.params as { name: string }).name, from, to);
  });

  // ---------------------------------------------------------------- live view (VNC websocket proxy)

  app.get(`${D}/vnc`, { websocket: true }, (socket, req) => {
    const id = did(req);
    const q = req.query as { mode?: string; generation?: string };
    const mode = q.mode === "control" ? "control" : "view";
    const generation = q.generation !== undefined && q.generation !== "" ? Number(q.generation) : undefined;
    let upstream: WebSocket;
    try {
      const d = desktops.require(id);
      const daemon = desktops.daemon(d);
      upstream = new WebSocket(daemon.vncUrl(mode, Number.isFinite(generation) ? generation : undefined), socket.protocol ? [socket.protocol] : [], {
        headers: { authorization: daemon.authHeader },
        perMessageDeflate: false,
      });
    } catch (e) {
      const msg = e instanceof DeskhandError ? e.message : "desktop unavailable";
      socket.close(4004, msg.slice(0, 120));
      return;
    }
    const queue: Array<{ data: WebSocket.RawData; binary: boolean }> = [];
    socket.on("message", (data: WebSocket.RawData, binary: boolean) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
      else queue.push({ data, binary });
    });
    upstream.on("open", () => {
      for (const m of queue.splice(0)) upstream.send(m.data, { binary: m.binary });
    });
    upstream.on("message", (data, binary) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data, { binary });
    });
    const closeBoth = (code?: number, reason?: string) => {
      const c = code && code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(c, reason);
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close(c, reason);
    };
    upstream.on("close", (code, reason) => closeBoth(code, reason.toString()));
    upstream.on("error", () => closeBoth(1011, "desktop connection failed"));
    socket.on("close", (code: number) => closeBoth(code));
    socket.on("error", () => closeBoth(1011));
  });
}
