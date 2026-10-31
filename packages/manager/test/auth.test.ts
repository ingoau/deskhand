import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthService, COOKIE_NAME, originAllowed, sessionCookieOptions } from "../src/auth.js";
import { openDb } from "../src/db.js";
import { sha256 } from "../src/util.js";
import type { FakeRuntime } from "../src/runtime/fake.js";
import { startManager, tmpDir, type TestManager } from "./helpers.js";

function service(now = { t: Date.parse("2026-10-22T00:00:00Z") }, enabled = true) {
  const db = openDb(":memory:");
  const dataDir = tmpDir();
  const auth = new AuthService(db, { enabled, dataDir, basePath: "/deskhand", trustProxy: true, publicUrl: null, now: () => now.t });
  return { db, auth, now, dataDir };
}

describe("login links", () => {
  it("work once and expire after 5 minutes", () => {
    const { auth, now } = service();
    const a = auth.createLoginCode();
    expect(Date.parse(a.expiresAt) - now.t).toBe(5 * 60_000);
    expect(auth.consumeLoginCode(a.code)).toBe(true);
    expect(auth.consumeLoginCode(a.code)).toBe(false);
    const b = auth.createLoginCode();
    now.t += 5 * 60_000 + 1;
    expect(auth.consumeLoginCode(b.code)).toBe(false);
    expect(auth.consumeLoginCode("made-up")).toBe(false);
    expect(auth.loginUrl("abc", "https://x.example")).toBe("https://x.example/deskhand/auth/login?code=abc");
  });
});

describe("API tokens", () => {
  it("are stored hashed, verified, and revoked independently", () => {
    const { auth, db } = service();
    const a = auth.createToken("claude-laptop");
    const b = auth.createToken("codex-box");
    expect(a.secret).toMatch(/^dh_/);
    const rows = db.prepare("SELECT hash FROM api_tokens").all() as Array<{ hash: string }>;
    expect(rows.map((r) => r.hash)).toContain(sha256(a.secret));
    expect(JSON.stringify(rows)).not.toContain(a.secret);
    expect(auth.verifyToken(a.secret)?.name).toBe("claude-laptop");
    expect(() => auth.createToken("claude-laptop")).toThrow(/already exists/);
    expect(auth.revokeToken("claude-laptop")).toBe(true);
    expect(auth.verifyToken(a.secret)).toBeNull();
    expect(auth.verifyToken(b.secret)?.name).toBe("codex-box");
    expect(auth.listTokens().map((t) => t.name)).toEqual(["codex-box"]);
    // Name can be reused after revocation.
    expect(auth.createToken("claude-laptop").token.name).toBe("claude-laptop");
  });

  it("creates the first token once", () => {
    const { auth } = service();
    const first = auth.initFirstStart();
    expect(first.firstStart).toBe(true);
    expect(first.token?.token.name).toBe("default");
    expect(auth.initFirstStart()).toEqual({ token: null, firstStart: false });
  });

  it("authenticates bearer tokens, the admin credential and cookies", () => {
    const { auth, dataDir } = service();
    const t = auth.createToken("x");
    expect(auth.authenticate({ authorization: `Bearer ${t.secret}` })).toMatchObject({ kind: "token", name: "x" });
    expect(auth.authenticate({ authorization: "Bearer dh_wrong" })).toBeNull();
    expect(auth.authenticate({})).toBeNull();
    auth.writeAdminCredential("http://127.0.0.1:7480");
    const file = path.join(dataDir, "admin.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const admin = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(auth.authenticate({ authorization: `Bearer ${admin.token}` })).toMatchObject({ kind: "admin", name: "cli" });
    const s = auth.createWebSession("link");
    expect(auth.authenticate({ cookie: `${COOKIE_NAME}=${s.value}` })).toMatchObject({ kind: "cookie", name: "dashboard" });
    expect(auth.authenticate({ cookie: `${COOKIE_NAME}=${s.value}` }, { allowCookie: false })).toBeNull();
    expect(auth.revokeAllWebSessions()).toBe(1);
    expect(auth.authenticate({ cookie: `${COOKIE_NAME}=${s.value}` })).toBeNull();
    // Token still works after sign-out-everywhere.
    expect(auth.authenticate({ authorization: `Bearer ${t.secret}` })).toMatchObject({ kind: "token" });
  });

  it("web sessions last 30 days", () => {
    const { auth, now } = service();
    const s = auth.createWebSession("link");
    now.t += 29 * 86_400_000;
    expect(auth.verifyWebSession(s.value)).not.toBeNull();
    now.t += 2 * 86_400_000;
    expect(auth.verifyWebSession(s.value)).toBeNull();
  });

  it("auth off lets everything through as anonymous", () => {
    const { auth } = service(undefined, false);
    expect(auth.authenticate({})).toMatchObject({ kind: "none", name: "anonymous" });
  });
});

describe("cookie flags and origin checks", () => {
  it("sets HttpOnly, SameSite=Strict, Path=base, 30 days, Secure only over HTTPS", () => {
    const plain = sessionCookieOptions({ headers: {} }, "/deskhand", true);
    expect(plain).toEqual({ httpOnly: true, sameSite: "strict", secure: false, path: "/deskhand", maxAge: 30 * 86400 });
    expect(sessionCookieOptions({ headers: { "x-forwarded-proto": "https" } }, "", true)).toMatchObject({ secure: true, path: "/" });
    expect(sessionCookieOptions({ headers: { "x-forwarded-proto": "https" } }, "", false).secure).toBe(false);
    expect(sessionCookieOptions({ headers: {}, encrypted: true }, "", false).secure).toBe(true);
  });

  it("only accepts the manager's own origin", () => {
    const o = { trustProxy: true, publicUrl: "https://desk.example.ts.net", requireHeader: true };
    expect(originAllowed({ headers: { host: "127.0.0.1:7480", origin: "http://127.0.0.1:7480" } }, o)).toBe(true);
    expect(originAllowed({ headers: { host: "127.0.0.1:7480", origin: "https://desk.example.ts.net" } }, o)).toBe(true);
    expect(originAllowed({ headers: { host: "127.0.0.1:7480", origin: "https://evil.example" } }, o)).toBe(false);
    expect(originAllowed({ headers: { host: "127.0.0.1:7480", referer: "http://127.0.0.1:7480/deskhand/x" } }, o)).toBe(true);
    expect(originAllowed({ headers: { host: "127.0.0.1:7480" } }, o)).toBe(false);
    expect(originAllowed({ headers: { host: "127.0.0.1:7480" } }, { ...o, requireHeader: false })).toBe(true);
    expect(originAllowed({ headers: { host: "127.0.0.1:7480", origin: "null" } }, { ...o, requireHeader: false })).toBe(false);
    expect(originAllowed({ headers: { host: "internal:7480", "x-forwarded-host": "desk.example.ts.net", "x-forwarded-proto": "https", origin: "https://desk.example.ts.net" } }, { ...o, publicUrl: null })).toBe(true);
  });
});

describe("auth over HTTP", () => {
  let t: TestManager;
  beforeAll(async () => {
    t = await startManager({ env: { DESKHAND_BASE_PATH: "/deskhand" } });
  });
  afterAll(async () => {
    await t.close();
    await (t.runtime as FakeRuntime).destroy();
  });
  const origin = () => new URL(t.url).origin;

  it("requires credentials for the API and MCP", async () => {
    expect((await fetch(`${t.url}/api/desktops`)).status).toBe(401);
    expect((await fetch(`${t.url}/api/desktops`, { headers: { authorization: `Bearer ${t.token}` } })).status).toBe(200);
    expect((await fetch(`${t.url}/healthz`)).status).toBe(200);
  });

  it("login link: sets the cookie, strips the code by redirect, works once", async () => {
    const link = await fetch(`${t.url}/api/login-links`, { method: "POST", headers: { authorization: `Bearer ${JSON.parse(fs.readFileSync(path.join(t.dataDir, "admin.json"), "utf8")).token}` } });
    expect(link.status).toBe(200);
    const { url } = (await link.json()) as { url: string };
    expect(url).toContain("/deskhand/auth/login?code=");
    const r1 = await fetch(url, { redirect: "manual" });
    expect(r1.status).toBe(303);
    expect(r1.headers.get("location")).toBe("/deskhand/");
    const cookie = r1.headers.get("set-cookie")!;
    expect(cookie).toMatch(new RegExp(`^${COOKIE_NAME}=`));
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/deskhand");
    expect(cookie).toContain("Max-Age=2592000");
    expect(cookie).not.toContain("Secure");
    const r2 = await fetch(url, { redirect: "manual" });
    expect(r2.headers.get("location")).toBe("/deskhand/?login=expired");
    expect(r2.headers.get("set-cookie")).toBeNull();

    const session = cookie.split(";")[0]!;
    const me = await fetch(`${t.url}/api/me`, { headers: { cookie: session } });
    expect(await me.json()).toMatchObject({ auth: true, via: "cookie", actor: "dashboard", basePath: "/deskhand" });

    // State-changing cookie requests need the dashboard's own origin.
    const noOrigin = await fetch(`${t.url}/api/tokens`, { method: "POST", headers: { cookie: session, "content-type": "application/json" }, body: JSON.stringify({ name: "n1" }) });
    expect(noOrigin.status).toBe(403);
    const evil = await fetch(`${t.url}/api/tokens`, { method: "POST", headers: { cookie: session, origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ name: "n1" }) });
    expect(evil.status).toBe(403);
    const good = await fetch(`${t.url}/api/tokens`, { method: "POST", headers: { cookie: session, origin: origin(), "content-type": "application/json" }, body: JSON.stringify({ name: "n1" }) });
    expect(good.status).toBe(201);
    const created = (await good.json()) as { token: { id: string }; secret: string };
    expect(created.secret).toMatch(/^dh_/);

    // Agent tokens cannot manage tokens.
    const asAgent = await fetch(`${t.url}/api/tokens`, { headers: { authorization: `Bearer ${t.token}` } });
    expect(asAgent.status).toBe(403);

    // Sign out everywhere ends the cookie session, not the tokens.
    const out = await fetch(`${t.url}/auth/logout-all`, { method: "POST", headers: { cookie: session, origin: origin() } });
    expect(out.status).toBe(204);
    expect((await fetch(`${t.url}/api/me`, { headers: { cookie: session } })).status).toBe(401);
    expect((await fetch(`${t.url}/api/me`, { headers: { authorization: `Bearer ${created.secret}` } })).status).toBe(200);
  });

  it("login with an API token sets a Secure cookie behind an HTTPS proxy", async () => {
    const r = await fetch(`${t.url}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-proto": "https", origin: origin().replace("http:", "https:") },
      body: JSON.stringify({ token: t.token }),
    });
    expect(r.status).toBe(204);
    expect(r.headers.get("set-cookie")).toContain("Secure");
    const bad = await fetch(`${t.url}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "dh_bad" }) });
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
  });

  it("percent-encoded paths cannot skip authentication", async () => {
    for (const p of ["/%61pi/desktops", "/%61%70%69/desktops", "/api/%64esktops", "/%61pi/templates", "/api/desktops/", "/%61uth/logout-all"]) {
      const r = await fetch(`${t.url}${p}`, { method: p.includes("logout") ? "POST" : "GET" });
      expect(r.status, p).toBe(401);
    }
  });

  it("token sign-ins cannot manage credentials and end when the token is revoked", async () => {
    const admin = JSON.parse(fs.readFileSync(path.join(t.dataDir, "admin.json"), "utf8")).token as string;
    const c = await fetch(`${t.url}/api/tokens`, { method: "POST", headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" }, body: JSON.stringify({ name: "agent-x" }) });
    const { token, secret } = (await c.json()) as { token: { id: string }; secret: string };
    const login = await fetch(`${t.url}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: secret }) });
    expect(login.status).toBe(204);
    const session = login.headers.get("set-cookie")!.split(";")[0]!;
    expect((await fetch(`${t.url}/api/desktops`, { headers: { cookie: session } })).status).toBe(200);
    const mint = await fetch(`${t.url}/api/tokens`, { method: "POST", headers: { cookie: session, origin: origin(), "content-type": "application/json" }, body: JSON.stringify({ name: "escalated" }) });
    expect(mint.status).toBe(403);
    expect((await fetch(`${t.url}/api/login-links`, { method: "POST", headers: { cookie: session, origin: origin() } })).status).toBe(403);
    await fetch(`${t.url}/api/tokens/${token.id}`, { method: "DELETE", headers: { authorization: `Bearer ${admin}` } });
    expect((await fetch(`${t.url}/api/desktops`, { headers: { cookie: session } })).status).toBe(401);
  });

  it("refuses unknown Host names (DNS rebinding)", async () => {
    const get = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const u = new URL(t.url);
        http.get({ host: u.hostname, port: u.port, path: "/deskhand/healthz", headers: { host } }, (res) => {
          res.resume();
          resolve(res.statusCode!);
        }).on("error", reject);
      });
    expect(await get("evil.example:7480")).toBe(421);
    expect(await get(`127.0.0.1:${new URL(t.url).port}`)).toBe(200);
    expect(await get("localhost:7480")).toBe(200);
    expect(await get("[::1]:7480")).toBe(200);
  });

  it("revoked tokens stop working immediately, including for MCP", async () => {
    const admin = JSON.parse(fs.readFileSync(path.join(t.dataDir, "admin.json"), "utf8")).token as string;
    const c = await fetch(`${t.url}/api/tokens`, { method: "POST", headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" }, body: JSON.stringify({ name: "short-lived" }) });
    const { token, secret } = (await c.json()) as { token: { id: string }; secret: string };
    expect((await fetch(`${t.url}/api/desktops`, { headers: { authorization: `Bearer ${secret}` } })).status).toBe(200);
    const del = await fetch(`${t.url}/api/tokens/${token.id}`, { method: "DELETE", headers: { authorization: `Bearer ${admin}` } });
    expect(del.status).toBe(204);
    expect((await fetch(`${t.url}/api/desktops`, { headers: { authorization: `Bearer ${secret}` } })).status).toBe(401);
  });
});

describe("DESKHAND_AUTH=off", () => {
  it("serves the API without credentials", async () => {
    const t = await startManager({ env: { DESKHAND_AUTH: "off" } });
    try {
      const r = await fetch(`${t.url}/api/me`);
      expect(await r.json()).toMatchObject({ auth: false, via: "none", actor: "anonymous" });
    } finally {
      await t.close();
      await (t.runtime as FakeRuntime).destroy();
    }
  });
});
