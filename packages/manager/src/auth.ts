/**
 * Authentication (plan: "Authentication").
 * - One-time login links: 5 minutes, single use, code stripped by redirect.
 * - Session cookie: HttpOnly, SameSite=Strict, Secure over HTTPS, Path = base path, 30 days.
 * - Named API tokens, stored as SHA-256 hashes (they are 256-bit random secrets, so a slow hash adds nothing).
 * - Origin check for state-changing requests and websockets; Host allow-list against DNS rebinding.
 * - Dashboard sessions signed in with an API token are tied to it (revoking the token ends them) and, like the
 *   token itself, cannot manage credentials.
 * - An admin credential file in the data dir for the CLI inside the manager container.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import type { IncomingHttpHeaders } from "node:http";
import { DeskhandError, type ApiToken } from "@deskhand/shared";
import type { DB } from "./db.js";
import { getMeta, setMeta } from "./db.js";
import { nowIso, randomId, secret, sha256 } from "./util.js";

export const COOKIE_NAME = "deskhand_session";
export const LOGIN_CODE_TTL_MS = 5 * 60_000;
export const WEB_SESSION_TTL_MS = 30 * 86_400_000;
export const TOKEN_PREFIX = "dh_";

export type Principal =
  | { kind: "token"; tokenId: string; name: string }
  | { kind: "cookie"; sessionHash: string; via: "link" | "token"; name: "dashboard" }
  | { kind: "admin"; name: "cli" }
  | { kind: "none"; name: "anonymous" };

export interface RequestLike {
  headers: IncomingHttpHeaders;
  /** true when the socket itself is TLS */
  encrypted?: boolean;
}

function first(h: string | string[] | undefined): string | undefined {
  const v = Array.isArray(h) ? h[0] : h;
  return v?.split(",")[0]?.trim() || undefined;
}

/** "https" when the request arrived over TLS, directly or (trusting the proxy) via X-Forwarded-Proto. */
export function requestProto(req: RequestLike, trustProxy: boolean): "http" | "https" {
  if (req.encrypted) return "https";
  if (trustProxy) {
    const xf = first(req.headers["x-forwarded-proto"]);
    if (xf === "https") return "https";
    const fwd = first(req.headers.forwarded);
    if (fwd && /proto=https/i.test(fwd)) return "https";
  }
  return "http";
}

export function requestHost(req: RequestLike, trustProxy: boolean): string | undefined {
  return (trustProxy ? first(req.headers["x-forwarded-host"]) : undefined) ?? first(req.headers.host);
}

/**
 * True if the request's Origin (or, failing that, Referer) is the manager's own origin:
 * the Host it was addressed to, or the configured public URL.
 * `requireHeader` makes a missing Origin/Referer a failure (cookie-authenticated writes, websockets).
 */
export function originAllowed(req: RequestLike, opts: { trustProxy: boolean; publicUrl: string | null; requireHeader: boolean }): boolean {
  let origin = first(req.headers.origin);
  if (!origin || origin === "null") {
    const ref = first(req.headers.referer);
    if (ref) {
      try {
        origin = new URL(ref).origin;
      } catch {
        return false;
      }
    } else if (origin === "null") {
      return false;
    }
  }
  if (!origin) return !opts.requireHeader;
  const allowed = new Set<string>();
  const host = requestHost(req, opts.trustProxy);
  if (host) {
    allowed.add(`${requestProto(req, opts.trustProxy)}://${host}`.toLowerCase());
    // Also accept the other scheme for the same host (TLS terminated by a proxy that does not set X-Forwarded-Proto).
    allowed.add(`http://${host}`.toLowerCase());
    allowed.add(`https://${host}`.toLowerCase());
  }
  if (opts.publicUrl) {
    try {
      allowed.add(new URL(opts.publicUrl).origin.toLowerCase());
    } catch {
      /* ignore */
    }
  }
  return allowed.has(origin.toLowerCase());
}

/**
 * DNS rebinding guard: a web page on evil.example that rebinds its name to the manager sends Host: evil.example
 * (and a matching Origin, so the origin check alone does not stop it). Accept only IP literals, localhost names, the
 * public URL's host, this machine's hostname and DESKHAND_ALLOWED_HOSTS (`*` turns the check off).
 */
export function hostAllowed(req: RequestLike, opts: { trustProxy: boolean; publicUrl: string | null; allowedHosts: string[] }): boolean {
  if (opts.allowedHosts.includes("*")) return true;
  const raw = requestHost(req, opts.trustProxy);
  if (!raw) return true; // HTTP/1.0 without Host: not something a browser sends
  let name: string;
  try {
    name = new URL(`http://${raw}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  const bare = name.replace(/^\[|\]$/g, "");
  if (net.isIP(bare)) return true;
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  const allowed = new Set(opts.allowedHosts.map((h) => h.toLowerCase()));
  allowed.add(os.hostname().toLowerCase());
  if (opts.publicUrl) {
    try {
      allowed.add(new URL(opts.publicUrl).hostname.toLowerCase());
    } catch {
      /* ignore */
    }
  }
  return allowed.has(name);
}

export interface CookieOptions {
  httpOnly: true;
  sameSite: "strict";
  secure: boolean;
  path: string;
  maxAge: number; // seconds
}

export function sessionCookieOptions(req: RequestLike, basePath: string, trustProxy: boolean): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "strict",
    secure: requestProto(req, trustProxy) === "https",
    path: basePath || "/",
    maxAge: Math.floor(WEB_SESSION_TTL_MS / 1000),
  };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function bearer(header: string | string[] | undefined): string | undefined {
  const h = Array.isArray(header) ? header[0] : header;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h ?? "");
  return m?.[1];
}

export interface AuthOptions {
  enabled: boolean;
  dataDir: string;
  basePath: string;
  trustProxy: boolean;
  publicUrl: string | null;
  /** DESKHAND_ALLOWED_HOSTS: extra Host names the manager answers to (`*`: any). */
  allowedHosts?: string[];
  now?: () => number;
}

export class AuthService {
  readonly enabled: boolean;
  private adminSecret: string | null = null;
  private now: () => number;

  constructor(
    private readonly db: DB,
    private readonly opts: AuthOptions,
  ) {
    this.enabled = opts.enabled;
    this.now = opts.now ?? Date.now;
  }

  private iso(ms = this.now()) {
    return new Date(ms).toISOString();
  }

  // ---------------------------------------------------------------- API tokens

  createToken(name: string): { token: ApiToken; secret: string } {
    const existing = this.db.prepare("SELECT id FROM api_tokens WHERE name = ? AND revoked_at IS NULL").get(name);
    if (existing) throw new DeskhandError("invalid_argument", `A token named "${name}" already exists; revoke it first or choose another name.`);
    const value = TOKEN_PREFIX + secret(32);
    const token: ApiToken = { id: randomId(8), name, createdAt: this.iso(), lastUsedAt: null };
    this.db.prepare("INSERT INTO api_tokens (id, name, hash, created_at) VALUES (?, ?, ?, ?)").run(token.id, name, sha256(value), token.createdAt);
    return { token, secret: value };
  }

  listTokens(): ApiToken[] {
    const rows = this.db.prepare("SELECT id, name, created_at, last_used_at FROM api_tokens WHERE revoked_at IS NULL ORDER BY created_at").all() as Array<{
      id: string;
      name: string;
      created_at: string;
      last_used_at: string | null;
    }>;
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at }));
  }

  /** Revokes by id or name. Returns false if nothing matched. */
  /** Revokes by id or name, with the dashboard sessions signed in with it. Returns false if nothing matched. */
  revokeToken(idOrName: string): boolean {
    const now = this.iso();
    return this.db.transaction(() => {
      const ids = this.db.prepare("SELECT id FROM api_tokens WHERE (id = ? OR name = ?) AND revoked_at IS NULL").all(idOrName, idOrName) as Array<{ id: string }>;
      for (const { id } of ids) {
        this.db.prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ?").run(now, id);
        this.db.prepare("UPDATE web_sessions SET revoked_at = ? WHERE token_id = ? AND revoked_at IS NULL").run(now, id);
      }
      return ids.length > 0;
    })();
  }

  verifyToken(value: string): { id: string; name: string } | null {
    if (!value.startsWith(TOKEN_PREFIX)) return null;
    const row = this.db.prepare("SELECT id, name, last_used_at FROM api_tokens WHERE hash = ? AND revoked_at IS NULL").get(sha256(value)) as
      | { id: string; name: string; last_used_at: string | null }
      | undefined;
    if (!row) return null;
    if (!row.last_used_at || this.now() - Date.parse(row.last_used_at) > 60_000) {
      this.db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(this.iso(), row.id);
    }
    return { id: row.id, name: row.name };
  }

  isTokenActive(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM api_tokens WHERE id = ? AND revoked_at IS NULL").get(id);
  }

  /** On first start: create the first API token. Returns its secret once, or null if already initialised. */
  initFirstStart(): { token: { token: ApiToken; secret: string } | null; firstStart: boolean } {
    if (getMeta(this.db, "initialized_at")) return { token: null, firstStart: false };
    setMeta(this.db, "initialized_at", this.iso());
    if (!this.enabled) return { token: null, firstStart: true };
    const has = this.db.prepare("SELECT 1 FROM api_tokens LIMIT 1").get();
    return { token: has ? null : this.createToken("default"), firstStart: true };
  }

  // ---------------------------------------------------------------- login links

  createLoginCode(): { code: string; expiresAt: string } {
    const code = secret(24);
    const expiresAt = this.iso(this.now() + LOGIN_CODE_TTL_MS);
    this.db.prepare("INSERT INTO login_codes (hash, created_at, expires_at) VALUES (?, ?, ?)").run(sha256(code), this.iso(), expiresAt);
    this.db.prepare("DELETE FROM login_codes WHERE expires_at < ?").run(this.iso(this.now() - 86_400_000));
    return { code, expiresAt };
  }

  /** Single use: the first successful call consumes the code. */
  consumeLoginCode(code: string): boolean {
    const r = this.db
      .prepare("UPDATE login_codes SET used_at = ? WHERE hash = ? AND used_at IS NULL AND expires_at > ?")
      .run(this.iso(), sha256(code), this.iso());
    return r.changes === 1;
  }

  loginUrl(code: string, origin: string): string {
    return `${origin}${this.opts.basePath}/auth/login?code=${encodeURIComponent(code)}`;
  }

  // ---------------------------------------------------------------- web sessions

  /** `via: "token"` sessions record the token they were signed in with (tokenId). */
  createWebSession(via: "link"): { value: string; expiresAt: string };
  createWebSession(via: "token", tokenId: string): { value: string; expiresAt: string };
  createWebSession(via: "link" | "token", tokenId?: string): { value: string; expiresAt: string } {
    const value = secret(32);
    const expiresAt = this.iso(this.now() + WEB_SESSION_TTL_MS);
    this.db
      .prepare("INSERT INTO web_sessions (hash, created_at, expires_at, via, token_id) VALUES (?, ?, ?, ?, ?)")
      .run(sha256(value), this.iso(), expiresAt, via, tokenId ?? null);
    return { value, expiresAt };
  }

  verifyWebSession(value: string): { hash: string; via: "link" | "token" } | null {
    const hash = sha256(value);
    const row = this.db
      .prepare(
        `SELECT s.hash, s.last_seen_at, s.via FROM web_sessions s
         WHERE s.hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
           AND (s.via != 'token' OR EXISTS (SELECT 1 FROM api_tokens t WHERE t.id = s.token_id AND t.revoked_at IS NULL))`,
      )
      .get(hash, this.iso()) as { hash: string; last_seen_at: string | null; via: string } | undefined;
    if (!row) return null;
    if (!row.last_seen_at || this.now() - Date.parse(row.last_seen_at) > 60_000) {
      this.db.prepare("UPDATE web_sessions SET last_seen_at = ? WHERE hash = ?").run(this.iso(), hash);
    }
    return { hash, via: row.via === "link" ? "link" : "token" };
  }

  revokeWebSession(value: string): void {
    this.db.prepare("UPDATE web_sessions SET revoked_at = ? WHERE hash = ? AND revoked_at IS NULL").run(this.iso(), sha256(value));
  }

  /** Sign out everywhere: ends every dashboard session. API tokens are unaffected. */
  revokeAllWebSessions(): number {
    return this.db.prepare("UPDATE web_sessions SET revoked_at = ? WHERE revoked_at IS NULL").run(this.iso()).changes;
  }

  // ---------------------------------------------------------------- admin credential (CLI)

  /** Writes {url, token, publicUrl} to <dataDir>/admin.json (0600). Rotated on every start. url is for the CLI next to the
   * manager (in compose: the in-container listen address); publicUrl is what users reach (for printed hints). */
  writeAdminCredential(url: string, publicUrl: string = url): string {
    this.adminSecret = "dha_" + secret(32);
    const file = path.join(this.opts.dataDir, "admin.json");
    fs.mkdirSync(this.opts.dataDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ url, publicUrl, token: this.adminSecret }) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
    return this.adminSecret;
  }

  private isAdmin(value: string): boolean {
    if (!this.adminSecret || value.length !== this.adminSecret.length) return false;
    return crypto.timingSafeEqual(Buffer.from(value), Buffer.from(this.adminSecret));
  }

  // ---------------------------------------------------------------- request authentication

  /** Authenticates by bearer token (API or admin) or session cookie. */
  authenticate(headers: IncomingHttpHeaders, opts: { allowCookie: boolean } = { allowCookie: true }): Principal | null {
    const b = bearer(headers.authorization);
    if (b) {
      if (this.isAdmin(b)) return { kind: "admin", name: "cli" };
      const t = this.verifyToken(b);
      if (t) return { kind: "token", tokenId: t.id, name: t.name };
      return this.enabled ? null : { kind: "none", name: "anonymous" };
    }
    if (opts.allowCookie) {
      const c = parseCookies(headers.cookie)[COOKIE_NAME];
      if (c) {
        const s = this.verifyWebSession(c);
        if (s) return { kind: "cookie", sessionHash: s.hash, via: s.via, name: "dashboard" };
      }
    }
    if (!this.enabled) return { kind: "none", name: "anonymous" };
    return null;
  }

  sessionCookieOptions(req: RequestLike): CookieOptions {
    return sessionCookieOptions(req, this.opts.basePath, this.opts.trustProxy);
  }

  hostAllowed(req: RequestLike): boolean {
    return hostAllowed(req, { trustProxy: this.opts.trustProxy, publicUrl: this.opts.publicUrl, allowedHosts: this.opts.allowedHosts ?? [] });
  }

  originAllowed(req: RequestLike, requireHeader: boolean): boolean {
    return originAllowed(req, { trustProxy: this.opts.trustProxy, publicUrl: this.opts.publicUrl, requireHeader });
  }
}
