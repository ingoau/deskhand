/**
 * Vite plugin that serves a mock manager API, so the dashboard runs standalone.
 *  - dev (`vite`): API at /api, /auth on the dev server; index.html gets `window.__DESKHAND_MOCK__ = true`.
 *  - preview (`MOCK=1 vite preview`): emulates the manager serving dist/ under `base` (default /deskhand/),
 *    including the `<base href>` rewrite, so the production bundle is tested under a sub-path.
 * Test helpers: POST {base}__mock/reset?auth=1&live=0, GET {base}__mock/state, POST {base}__mock/request-human.
 * This file is loaded only by vite.config.ts at dev/preview time; it never reaches the browser bundle.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Connect, Plugin } from "vite";
import { ERROR_MESSAGES, ERROR_STATUS, type ErrorCode } from "../../shared/src/errors.ts";
import type { CreateDesktopRequest, TemplateDescription, TemplateVersion } from "../../shared/src/index.ts";
import {
  addLog,
  createState,
  publicDesktop,
  randomId,
  refreshTemplate,
  systemSummary,
  templateSummary,
  tick,
  type MockDesktop,
  type MockState,
} from "./data.ts";
import { SCREEN, sceneSvg, startingSvg, wanderingCursor, type SceneKind } from "./images.ts";

const COOKIE = "deskhand_session";
const iso = (ms = Date.now()) => new Date(ms).toISOString();

class HttpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message?: string,
  ) {
    super(message ?? ERROR_MESSAGES[code]);
  }
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  /** Path relative to the base, without leading slash, e.g. `api/desktops/7f3a`. */
  path: string;
  query: URLSearchParams;
  params: string[];
  state: MockState;
  base: string;
  body: () => Promise<Buffer>;
  json: <T = Record<string, unknown>>() => Promise<T>;
}

type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) {
  res.statusCode = status;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  if (body === undefined) return res.end();
  if (typeof body === "string" || Buffer.isBuffer(body)) return res.end(body);
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, code: ErrorCode, message?: string) {
  send(res, ERROR_STATUS[code], { error: { code, message: message ?? ERROR_MESSAGES[code] } });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Minimal multipart/form-data parser: returns text fields and the byte length of file fields. */
function parseMultipart(body: Buffer, contentType: string): { fields: Record<string, string>; files: Record<string, { filename: string; size: number }> } {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const fields: Record<string, string> = {};
  const files: Record<string, { filename: string; size: number }> = {};
  if (!m) return { fields, files };
  const boundary = Buffer.from(`--${m[1] ?? m[2]}`);
  let pos = body.indexOf(boundary);
  while (pos !== -1) {
    const start = pos + boundary.length;
    if (body.subarray(start, start + 2).toString() === "--") break;
    const headerEnd = body.indexOf("\r\n\r\n", start);
    if (headerEnd === -1) break;
    const headers = body.subarray(start, headerEnd).toString();
    const next = body.indexOf(boundary, headerEnd);
    const content = body.subarray(headerEnd + 4, next === -1 ? body.length : next - 2);
    const name = /name="([^"]*)"/.exec(headers)?.[1];
    const filename = /filename="([^"]*)"/.exec(headers)?.[1];
    if (name) {
      if (filename != null) files[name] = { filename, size: content.length };
      else fields[name] = content.toString();
    }
    pos = next;
  }
  return { fields, files };
}

// ---- helpers ----------------------------------------------------------------------------------

function getDesktop(state: MockState, id: string): MockDesktop {
  const d = state.desktops.get(id);
  if (!d) throw new HttpError("desktop_not_found", `No desktop with id ${id}.`);
  return d;
}

function requireRunning(d: MockDesktop) {
  // The manager answers 409 desktop_stopped for anything that needs a running desktop.
  if (d.status !== "running") throw new HttpError("desktop_stopped", `Desktop ${d.id} is ${d.status}; start it first.`);
}

function dashboardLog(state: MockState, d: MockDesktop, tool: string, summary: string, args: unknown = {}, hasScreenshot = false) {
  addLog(state, {
    desktopId: d.id,
    at: iso(),
    tool,
    args,
    summary,
    outcome: "ok",
    error: null,
    actor: "dashboard",
    session: null,
    durationMs: 30 + Math.round(Math.random() * 60),
    overlays: [],
    hasScreenshot,
  });
}

const TEMPLATE_SCENE: Record<string, { scene: SceneKind; accent: string }> = {
  base: { scene: "blank", accent: "#2b2d31" },
  research: { scene: "issues", accent: "#5a62d6" },
  "vendor-portals": { scene: "captcha", accent: "#2f6b52" },
  office: { scene: "sheet", accent: "#1f6f3c" },
};

// Simulated agent activity so the grid feels alive in the demo.
const LIVE_SCRIPTS: Record<string, { tool: string; summary: string; overlays?: MockState["log"][number]["overlays"] }[]> = {
  "2c91": [
    { tool: "left_click", summary: "left_click [812, 388]", overlays: [{ kind: "point", at: [812, 388] }] },
    { tool: "browser_snapshot", summary: "browser_snapshot()" },
    { tool: "key", summary: "key ctrl+k" },
    { tool: "type", summary: 'type "set priority high"' },
    { tool: "left_click", summary: "left_click [812, 344]", overlays: [{ kind: "point", at: [812, 344] }] },
  ],
  "5a77": [
    { tool: "screenshot", summary: "screenshot" },
    { tool: "left_click_drag", summary: "left_click_drag [212,380]→[904,410]", overlays: [{ kind: "path", points: [[212, 380], [560, 360], [904, 410]] }] },
    { tool: "zoom", summary: "zoom [820, 330, 990, 490]", overlays: [{ kind: "region", region: [820, 330, 990, 490] }] },
  ],
  e1d8: [
    { tool: "scroll", summary: "scroll down 5 [640, 500]", overlays: [{ kind: "point", at: [640, 500] }] },
    { tool: "browser_snapshot", summary: "browser_snapshot()" },
  ],
};

function liveActivity(state: MockState & { live?: boolean; liveStep?: number; lastLive?: number }) {
  if (state.live === false) return;
  const now = Date.now();
  if (state.lastLive && now - state.lastLive < 7000) return;
  state.lastLive = now;
  state.liveStep = (state.liveStep ?? 0) + 1;
  const ids = Object.keys(LIVE_SCRIPTS);
  const id = ids[state.liveStep % ids.length]!;
  const d = state.desktops.get(id);
  if (!d || d.status !== "running" || d.lock || d.attention) return;
  const script = LIVE_SCRIPTS[id]!;
  const s = script[Math.floor(state.liveStep / ids.length) % script.length]!;
  addLog(state, {
    desktopId: id,
    at: iso(now),
    tool: s.tool,
    args: {},
    summary: s.summary,
    outcome: "ok",
    error: null,
    actor: d.session?.split("/")[0] ?? null,
    session: d.session,
    durationMs: 300 + Math.round(Math.random() * 600),
    overlays: s.overlays ?? [],
    hasScreenshot: s.tool !== "browser_snapshot",
  });
}

// ---- routes -----------------------------------------------------------------------------------

const routes: [string, RegExp, Handler][] = [];
const route = (method: string, pattern: string, h: Handler) => {
  const re = new RegExp("^" + pattern.replace(/:[a-z]+/g, "([^/]+)") + "$");
  routes.push([method, re, h]);
};

route("GET", "api/system", ({ state }) => systemSummary(state));

route("GET", "api/desktops", ({ state }) => ({ desktops: [...state.desktops.values()].map(publicDesktop) }));

route("POST", "api/desktops", async ({ state, json, res }) => {
  const body = await json<CreateDesktopRequest>();
  const name = body.template ?? [...state.templates.values()].find((t) => t.isDefault)?.name ?? "base";
  const t = state.templates.get(name);
  if (!t) throw new HttpError("template_not_found");
  const active = [...state.desktops.values()].filter((d) => d.status === "running" || d.status === "starting").length;
  if (active >= 8) throw new HttpError("limit_reached");
  const id = randomId();
  const now = Date.now();
  const look = TEMPLATE_SCENE[name] ?? TEMPLATE_SCENE.base!;
  const d: MockDesktop = {
    id,
    name: `deskhand-${id}`,
    title: body.name?.trim() || null,
    session: "dashboard",
    sessionIndex: 0,
    template: name,
    templateVersion: t.currentVersion,
    status: "starting",
    persistent: body.persistent ?? false,
    attention: null,
    lock: null,
    generation: 1,
    lastHandback: null,
    lastAction: null,
    createdAt: iso(now),
    startedAt: null,
    stoppedAt: null,
    lastActivityAt: null,
    screen: body.screen ?? { ...SCREEN },
    mounts: body.mounts ?? [],
    cpuPercent: null,
    memoryBytes: null,
    diskBytes: null,
    scene: look.scene,
    accent: look.accent,
    readyAt: now + 4000,
  };
  state.desktops.set(id, d);
  res.statusCode = 201;
  return publicDesktop(d);
});

route("GET", "api/desktops/:id", ({ state, params }) => publicDesktop(getDesktop(state, params[0]!)));

route("DELETE", "api/desktops/:id", ({ state, params, res }) => {
  getDesktop(state, params[0]!);
  state.desktops.delete(params[0]!);
  send(res, 204);
});

route("POST", "api/desktops/:id/stop", ({ state, params }) => {
  const d = getDesktop(state, params[0]!);
  Object.assign(d, { status: "stopped", stoppedAt: iso(), lock: null, attention: null, cpuPercent: null, memoryBytes: null });
  dashboardLog(state, d, "desktop_stop", "desktop_stop()");
  return publicDesktop(d);
});

route("POST", "api/desktops/:id/start", ({ state, params }) => {
  const d = getDesktop(state, params[0]!);
  if (d.status === "stopped") Object.assign(d, { status: "starting", stoppedAt: null, readyAt: Date.now() + 3000 });
  return publicDesktop(d);
});

route("POST", "api/desktops/:id/persistent", async ({ state, params, json }) => {
  const d = getDesktop(state, params[0]!);
  const { persistent } = await json<{ persistent: boolean }>();
  if (typeof persistent !== "boolean") throw new HttpError("invalid_argument", "persistent must be a boolean");
  d.persistent = persistent;
  return publicDesktop(d);
});

route("POST", "api/desktops/:id/lock", ({ state, params }) => {
  const d = getDesktop(state, params[0]!);
  requireRunning(d);
  if (!d.lock) {
    d.generation += 1;
    d.lock = { holder: "dashboard", since: iso(), generation: d.generation };
    dashboardLog(state, d, "takeover", "takeover", {}, true);
  }
  return { generation: d.generation, lock: d.lock };
});

route("DELETE", "api/desktops/:id/lock", async ({ state, params, json }) => {
  const d = getDesktop(state, params[0]!);
  const { note } = await json<{ note?: string | null }>();
  const clean = typeof note === "string" && note.trim() ? note.trim() : null;
  d.generation += 1;
  d.lock = null;
  d.attention = null;
  d.lastHandback = { note: clean, at: iso(), generation: d.generation };
  dashboardLog(state, d, "handback", clean ? `handback("${clean}")` : "handback", { note: clean }, true);
  return { generation: d.generation, lock: null };
});

route("DELETE", "api/desktops/:id/attention", async ({ state, params, json }) => {
  const d = getDesktop(state, params[0]!);
  await json<{ note?: string | null }>();
  d.attention = null;
  return publicDesktop(d);
});

route("POST", "api/desktops/:id/save-as-template", async ({ state, params, json }) => {
  const d = getDesktop(state, params[0]!);
  const body = await json<{ name?: string; description?: Partial<TemplateDescription>; confirm_description?: boolean }>();
  const name = (body.name ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) throw new HttpError("invalid_argument", "Template names use lowercase letters, digits and dashes.");
  // Like the manager (phase 4): a new version restates the description or confirms the current one.
  const prior = state.templates.get(name);
  if (prior && !body.description && !body.confirm_description)
    throw new HttpError("invalid_argument", `"${name}" exists: restate its description or pass confirm_description to keep "${prior.description.summary}".`);
  const desc: Partial<TemplateDescription> = body.description ?? (prior && body.confirm_description ? prior.description : {});
  if (!desc.summary?.trim() || !desc.use_when?.trim()) throw new HttpError("invalid_argument", "summary and use_when are required.");
  await new Promise((r) => setTimeout(r, 1200)); // quiesce + docker commit
  const src = state.templates.get(d.template);
  const srcVersion = src?.versions.find((v) => v.version === d.templateVersion);
  const existing = state.templates.get(name);
  const v = existing ? Math.max(...existing.versions.map((x) => x.version)) + 1 : 1;
  const tv: TemplateVersion = {
    version: v,
    image: `deskhand-template:${name}-v${v}`,
    createdAt: iso(),
    savedBy: "dashboard",
    byAgent: false,
    baseVersion: "0.1.0",
    hasRecipe: false,
    description: {
      summary: desc.summary.trim(),
      use_when: desc.use_when.trim(),
      ...(desc.not_for?.trim() ? { not_for: desc.not_for.trim() } : {}),
      ...(desc.setup_notes?.trim() ? { setup_notes: desc.setup_notes.trim() } : {}),
      ...(desc.tags?.length ? { tags: desc.tags } : {}),
    },
    loggedInSites: srcVersion?.loggedInSites ?? [],
    extensions: srcVersion?.extensions ?? [],
    packages: srcVersion?.packages ?? [],
    sizeBytes: 1.5 * 1024 ** 3,
    inUse: 0,
    savedFrom: { desktop: d.id, title: d.title, session: "dashboard" },
  };
  const now = Date.now();
  const t = existing
    ? refreshTemplate({ ...existing, versions: [tv, ...existing.versions], currentVersion: v }, now)
    : refreshTemplate(
        {
          name,
          currentVersion: 1,
          latestVersion: 1,
          description: tv.description,
          loggedInSites: tv.loggedInSites,
          updatedAt: tv.createdAt,
          recentlyChangedByAgent: false,
          lastFeedback: null,
          lastConfirmedAt: null,
          stale: false,
          outdatedBase: false,
          isDefault: false,
          versions: [tv],
          feedback: [],
          recipe: null,
        },
        now,
      );
  state.templates.set(name, t);
  dashboardLog(state, d, "template_save", `template_save("${name}") → v${v}`);
  return { template: templateSummary(t), version: v, notes: [] };
});

route("POST", "api/desktops/:id/files", async ({ state, params, req, body }) => {
  const d = getDesktop(state, params[0]!);
  const { fields, files } = parseMultipart(await body(), req.headers["content-type"] ?? "");
  const file = files.file;
  if (!file) throw new HttpError("invalid_argument", "multipart field `file` is required");
  const target = fields.path?.trim() || `/home/agent/Downloads/${file.filename}`;
  if (!target.startsWith("/")) throw new HttpError("invalid_argument", "path must be absolute");
  state.uploads.push({ desktopId: d.id, path: target, bytes: file.size, at: iso() });
  dashboardLog(state, d, "file_put", `file_put("${target}")`, { path: target });
  return { path: target, bytes: file.size };
});

route("GET", "api/desktops/:id/files", ({ state, params, query, res }) => {
  getDesktop(state, params[0]!);
  const p = query.get("path") ?? "";
  if (!p.startsWith("/")) throw new HttpError("invalid_argument", "path must be absolute");
  const up = state.uploads.find((u) => u.desktopId === params[0] && u.path === p);
  const content = up ? `mock contents of ${p} (${up.bytes} bytes uploaded)\n` : `mock file ${p}\n`;
  send(res, 200, content, {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${path.posix.basename(p) || "download"}"`,
  });
});

route("GET", "api/desktops/:id/log", ({ state, params, query }) => {
  getDesktop(state, params[0]!);
  const before = query.get("before") ? Number(query.get("before")) : Infinity;
  const limit = Math.min(200, Math.max(1, Number(query.get("limit") ?? 50)));
  const entries = state.log
    .filter((e) => e.desktopId === params[0] && e.id < before)
    .sort((a, b) => b.id - a.id)
    .slice(0, limit);
  return { entries };
});

route("GET", "api/desktops/:id/thumbnail", ({ state, params, res }) => {
  const d = getDesktop(state, params[0]!);
  const svg =
    d.status === "starting"
      ? startingSvg()
      : sceneSvg({ kind: d.scene, accent: d.accent, cursor: d.status === "running" && !d.attention ? wanderingCursor(d.id.charCodeAt(0), Date.now()) : d.attention ? [640, 470] : null }, 320, 200);
  send(res, 200, svg, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" });
});

route("GET", "api/desktops/:id/vnc", ({ res }) => {
  send(res, 501, { error: { code: "daemon_unavailable", message: "Live view is not available in the mock API." } });
});

route("GET", "api/log/:id/screenshot", ({ state, params, query, res }) => {
  const e = state.log.find((x) => x.id === Number(params[0]));
  if (!e || !e.hasScreenshot) throw new HttpError("invalid_argument", "No screenshot stored for this entry.");
  const d = state.desktops.get(e.desktopId);
  const first = e.overlays.find((o) => o.kind === "point");
  const path = e.overlays.find((o) => o.kind === "path");
  const cursor: [number, number] | null = first?.kind === "point" ? [first.at[0], first.at[1]] : path?.kind === "path" ? [path.points.at(-1)![0], path.points.at(-1)![1]] : null;
  const thumb = query.get("thumb") === "1";
  const svg = sceneSvg(
    { kind: d?.scene ?? "blank", accent: d?.accent ?? "#2b2d31", cursor, step: e.tool === "left_click_drag" ? 1 : e.id },
    thumb ? 320 : SCREEN.width,
    thumb ? 200 : SCREEN.height,
  );
  send(res, 200, svg, { "Content-Type": "image/svg+xml", "Cache-Control": "private, max-age=86400" });
});

route("GET", "api/templates", ({ state }) => ({ templates: [...state.templates.values()].map(templateSummary) }));

route("GET", "api/templates/:name", ({ state, params }) => {
  const t = state.templates.get(decodeURIComponent(params[0]!));
  if (!t) throw new HttpError("template_not_found");
  return t;
});

route("DELETE", "api/templates/:name", ({ state, params, res }) => {
  const name = decodeURIComponent(params[0]!);
  const t = state.templates.get(name);
  if (!t) throw new HttpError("template_not_found");
  if (name === "base") throw new HttpError("forbidden", "The base template can't be deleted.");
  if (t.isDefault) throw new HttpError("invalid_argument", "This is the default template; make another one the default first.");
  state.templates.delete(name);
  send(res, 204);
});

route("POST", "api/templates/:name/rollback", async ({ state, params, json }) => {
  const name = decodeURIComponent(params[0]!);
  const t = state.templates.get(name);
  if (!t) throw new HttpError("template_not_found");
  const { version } = await json<{ version: number }>();
  if (!t.versions.some((v) => v.version === version)) throw new HttpError("invalid_argument", `No version ${version} of ${name}.`);
  const next = refreshTemplate({ ...t, currentVersion: version }, Date.now());
  state.templates.set(name, next);
  return next;
});

route("PUT", "api/templates/:name/recipe", async ({ state, params, json }) => {
  const name = decodeURIComponent(params[0]!);
  const t = state.templates.get(name);
  if (!t) throw new HttpError("template_not_found");
  const { recipe } = await json<{ recipe?: string | null }>();
  const r = recipe && recipe.trim() ? recipe : null;
  const versions = t.versions.map((v) => (v.version === t.currentVersion ? { ...v, hasRecipe: !!r, recipe: r } : v));
  const next = refreshTemplate({ ...t, versions, recipe: r, hasRecipe: !!r }, Date.now());
  state.templates.set(name, next);
  return next;
});

route("POST", "api/templates/:name/rebuild", async ({ state, params }) => {
  const name = decodeURIComponent(params[0]!);
  const t = state.templates.get(name);
  if (!t) throw new HttpError("template_not_found");
  if (!t.recipe) throw new HttpError("invalid_argument", `"${name}" has no recipe, so it can't be rebuilt; save it again on the new base instead.`);
  await new Promise((r) => setTimeout(r, 800));
  const cur = t.versions.find((v) => v.version === t.currentVersion)!;
  const v = Math.max(...t.versions.map((x) => x.version)) + 1;
  const tv: TemplateVersion = { ...cur, version: v, image: `deskhand-template:${name}-v${v}`, createdAt: iso(), savedBy: "deskhand (base update)", byAgent: false, baseVersion: "0.2.0", rebuiltFrom: cur.version, savedFrom: null, inUse: 0 };
  const next = refreshTemplate(
    { ...t, versions: [tv, ...t.versions], currentVersion: v, outdatedBase: false, baseVersion: "0.2.0", rebuild: { status: "ok", at: iso(), baseVersion: "0.2.0", error: null, version: v } },
    Date.now(),
  );
  state.templates.set(name, next);
  return { template: templateSummary(next), version: v };
});

route("POST", "api/templates/:name/default", ({ state, params }) => {
  const name = decodeURIComponent(params[0]!);
  const t = state.templates.get(name);
  if (!t) throw new HttpError("template_not_found");
  for (const [k, v] of state.templates) state.templates.set(k, { ...v, isDefault: k === name });
  return state.templates.get(name);
});

route("GET", "api/tokens", ({ state }) => ({ tokens: state.tokens.map((t) => t.token) }));

route("POST", "api/tokens", async ({ state, json, res }) => {
  const { name } = await json<{ name?: string }>();
  const n = (name ?? "").trim();
  if (!/^[a-zA-Z0-9][\w.-]{0,40}$/.test(n)) throw new HttpError("invalid_argument", "Token names use letters, digits, dot, dash and underscore.");
  if (state.tokens.some((t) => t.token.name === n)) throw new HttpError("invalid_argument", `A token named ${n} already exists.`);
  const created = { token: { id: `tok_${randomId(6)}`, name: n, createdAt: iso(), lastUsedAt: null }, secret: `dh_${randomId(32)}` };
  state.tokens.push(created);
  res.statusCode = 201;
  return created;
});

route("DELETE", "api/tokens/:id", ({ state, params, res }) => {
  const i = state.tokens.findIndex((t) => t.token.id === params[0]);
  if (i === -1) throw new HttpError("invalid_argument", "No such token.");
  state.tokens.splice(i, 1);
  send(res, 204);
});

function sessionCookie(base: string, value: string, maxAge: number) {
  return `${COOKIE}=${value}; Path=${base}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

route("POST", "auth/login", async ({ state, json, res, base }) => {
  const { token } = await json<{ token?: string }>();
  const ok = !!token && (token === "dh_demo" || state.tokens.some((t) => t.secret === token));
  if (!ok) throw new HttpError("unauthorized", "That token isn't valid. Check it, or use a login link from `deskhand login-link`.");
  const sid = randomId(16);
  state.sessions.add(sid);
  send(res, 204, undefined, { "Set-Cookie": sessionCookie(base, sid, 30 * 24 * 3600) });
});

route("GET", "auth/login", ({ state, res, base, query }) => {
  // Like the manager: an expired/used code lands on `${base}?login=expired` (code "expired" simulates one).
  const code = query.get("code");
  if (!code || code === "expired") return send(res, 303, undefined, { Location: `${base}?login=${code ? "expired" : "missing"}` });
  const sid = randomId(16);
  state.sessions.add(sid);
  send(res, 302, undefined, { "Set-Cookie": sessionCookie(base, sid, 30 * 24 * 3600), Location: base });
});

route("POST", "auth/logout-all", ({ state, res, base }) => {
  state.sessions.clear();
  state.authRequired = true;
  send(res, 204, undefined, { "Set-Cookie": sessionCookie(base, "", 0) });
});

// ---- plugin -----------------------------------------------------------------------------------

export function mockApi(opts: { base: string }): Plugin {
  let state: MockState & { live?: boolean } = createState();
  const previewBase = opts.base.endsWith("/") ? opts.base : opts.base + "/";
  let distDir = "dist";

  const handle = async (req: IncomingMessage, res: ServerResponse, rel: string, base: string): Promise<boolean> => {
    const u = new URL(req.url ?? "/", "http://mock");
    const method = req.method ?? "GET";

    const relPath = rel.split("?")[0]!;
    if (relPath.startsWith("__mock/")) {
      if (relPath === "__mock/reset") {
        state = createState({ authRequired: u.searchParams.get("auth") === "1" });
        state.live = u.searchParams.get("live") !== "0";
        send(res, 204);
      } else if (relPath === "__mock/state") {
        send(res, 200, { uploads: state.uploads, authRequired: state.authRequired, desktops: [...state.desktops.values()].map(publicDesktop) });
      } else if (relPath === "__mock/request-human" && method === "POST") {
        const b = JSON.parse((await readBody(req)).toString() || "{}") as { id?: string; reason?: string };
        const d = state.desktops.get(b.id ?? "");
        if (!d) return sendError(res, "desktop_not_found"), true;
        d.attention = { reason: b.reason ?? "Needs a human", since: iso(), timeoutAt: iso(Date.now() + 10 * 60_000) };
        send(res, 204);
      } else send(res, 404);
      return true;
    }
    if (!relPath.startsWith("api/") && !relPath.startsWith("auth/")) return false;

    tick(state);
    liveActivity(state);

    const authed = !state.authRequired || state.sessions.has(parseCookies(req)[COOKIE] ?? "");
    if (!authed && relPath.startsWith("api/")) {
      sendError(res, "unauthorized");
      return true;
    }
    const pathOnly = relPath;
    for (const [m, re, h] of routes) {
      if (m !== method) continue;
      const match = re.exec(pathOnly);
      if (!match) continue;
      let cached: Buffer | undefined;
      const body = async () => (cached ??= await readBody(req));
      const ctx: Ctx = {
        req,
        res,
        method,
        path: pathOnly,
        query: u.searchParams,
        params: match.slice(1),
        state,
        base,
        body,
        json: async <T,>() => {
          const b = await body();
          if (!b.length) return {} as T;
          try {
            return JSON.parse(b.toString()) as T;
          } catch {
            throw new HttpError("invalid_argument", "Body is not valid JSON.");
          }
        },
      };
      try {
        // Small latency so loading states are exercised.
        await new Promise((r) => setTimeout(r, 40));
        const out = await h(ctx);
        if (!res.writableEnded) send(res, res.statusCode && res.statusCode !== 200 ? res.statusCode : 200, out ?? undefined);
      } catch (e) {
        if (e instanceof HttpError) sendError(res, e.code, e.message);
        else {
          console.error("[mock]", e);
          sendError(res, "internal");
        }
      }
      return true;
    }
    sendError(res, "invalid_argument", `mock: no route for ${method} /${pathOnly}`);
    return true;
  };

  const injectMockFlag = (html: string) => html.replace("<head>", `<head>\n    <script>window.__DESKHAND_MOCK__ = true</script>`);

  return {
    name: "deskhand-mock-api",
    configResolved(cfg) {
      distDir = path.resolve(cfg.root, cfg.build.outDir);
    },
    transformIndexHtml(html) {
      return injectMockFlag(html);
    },
    configureServer(server) {
      // Dev server: app at "/", API unprefixed.
      server.middlewares.use((req, res, next) => {
        const rel = (req.url ?? "/").replace(/^\/+/, "");
        handle(req, res, rel, "/").then((done) => (done ? undefined : next()), next);
      });
    },
    configurePreviewServer(server) {
      // Emulate the manager: everything under previewBase, SPA fallback with <base href> rewritten.
      const mw: Connect.NextHandleFunction = (req, res, next) => {
        const raw = req.url ?? "/";
        const pathname = raw.split("?")[0]!;
        if (pathname === "/" || pathname === previewBase.slice(0, -1)) {
          send(res, 302, undefined, { Location: previewBase });
          return;
        }
        if (!pathname.startsWith(previewBase)) return next();
        const rel = raw.slice(previewBase.length);
        handle(req, res, rel, previewBase)
          .then(async (done) => {
            if (done) return;
            const relPath = rel.split("?")[0]!;
            if (/^(assets\/|favicon\.svg$)/.test(relPath)) {
              req.url = "/" + rel;
              return next();
            }
            const html = await readFile(path.join(distDir, "index.html"), "utf8");
            const out = injectMockFlag(html.replace('<base href="/" />', `<base href="${previewBase}" />`));
            send(res, 200, out, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
          })
          .catch(next);
      };
      server.middlewares.use(mw);
    },
  };
}
