/**
 * Serves the dashboard's static build (packages/dashboard/dist by default, DESKHAND_DASHBOARD_DIR)
 * under the base path, with SPA fallback. index.html gets the base path injected:
 * a <base href="<base>/"> and window.__DESKHAND_BASE__ = "<base>/".
 */
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import type { Config } from "./config.js";

const RESERVED = /^\/(api|auth|mcp|healthz)(\/|$)/;

export function injectBase(html: string, base: string): string {
  const href = `${base}/`;
  const tags = `<base href="${href}"><script>window.__DESKHAND_BASE__ = ${JSON.stringify(href)};</script>`;
  const cleaned = html.replace(/<base\s[^>]*>/i, "");
  if (/<head[^>]*>/i.test(cleaned)) return cleaned.replace(/<head[^>]*>/i, (m) => `${m}${tags}`);
  return tags + cleaned;
}

const PLACEHOLDER = (base: string) => `<!doctype html><html><head><meta charset="utf-8"><title>deskhand</title></head>
<body style="font-family: ui-monospace, monospace; background:#0b0d10; color:#cbd5e1; padding:2rem">
<h1>deskhand</h1><p>The manager is running, but the dashboard has not been built.</p>
<p>API: <code>${base}/api</code> · MCP: <code>${base}/mcp</code> · health: <code>${base}/healthz</code></p></body></html>`;

export async function registerStatic(app: FastifyInstance, cfg: Config): Promise<void> {
  const base = cfg.basePath;
  const root = cfg.dashboardDir && fs.existsSync(path.join(cfg.dashboardDir, "index.html")) ? path.resolve(cfg.dashboardDir) : null;
  let cache: { mtimeMs: number; html: string } | null = null;

  const index = (): string => {
    if (!root) return PLACEHOLDER(base);
    const file = path.join(root, "index.html");
    const st = fs.statSync(file);
    if (!cache || cache.mtimeMs !== st.mtimeMs) cache = { mtimeMs: st.mtimeMs, html: injectBase(fs.readFileSync(file, "utf8"), base) };
    return cache.html;
  };

  if (root) await app.register(fastifyStatic, { root, serve: false });

  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const rel = decodeURIComponent((req.url.split("?")[0] ?? "/").slice(base.length)) || "/";
    if (RESERVED.test(rel)) return reply.status(404).send({ error: { code: "not_found", message: "Not found." } });
    if (root && rel !== "/" && rel !== "/index.html") {
      const file = path.resolve(root, "." + path.posix.normalize(rel));
      if (file.startsWith(root + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const immutable = /\/assets\//.test(rel);
        return reply.header("cache-control", immutable ? "public, max-age=31536000, immutable" : "no-cache").sendFile(path.relative(root, file), { cacheControl: false });
      }
      // Missing asset-like paths are real 404s, not the SPA.
      if (/\.[a-z0-9]{1,8}$/i.test(rel)) return reply.status(404).send({ error: { code: "not_found", message: "Not found." } });
    }
    return reply.header("cache-control", "no-cache").type("text/html; charset=utf-8").send(index());
  };
  app.get("/", handler);
  app.get("/*", handler);
}
