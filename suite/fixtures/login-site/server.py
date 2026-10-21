#!/usr/bin/env python3
"""A tiny shop with a cookie-based login, for template tests (Python 3 stdlib only).

  python3 server.py [--port 8080] [--user alice] [--password correct-horse]

Pages:
  GET  /           "Signed in as <user>" when the session cookie is valid, else a link to /login
  GET  /login      login form (#username, #password, #remember, #submit)
  POST /login      checks the credentials; sets `shop_session` (HttpOnly; persistent for 30 days when
                   "remember me" is ticked, which is the default) and redirects to /
  POST /logout     clears the session
  GET  /whoami     JSON {"user": "<user>"} or 401 {"user": null}: what the test harness checks
  GET  /sessions   JSON {"count": N}: how many logins happened (proves a template reused one)

Sessions are kept in memory, so a login only survives as long as this process — which is what a
test needs: a desktop that is "already logged in" must carry the cookie of a login made earlier.
"""
import argparse
import html
import json
import secrets
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

SESSIONS: dict[str, str] = {}
LOGINS = {"count": 0}


def page(title: str, body: str) -> bytes:
    return (
        "<!doctype html><html><head><meta charset='utf-8'><title>%s</title>"
        "<style>body{font:16px sans-serif;margin:40px;max-width:520px}input,button{font-size:16px;margin:6px 0;padding:6px}"
        "label{display:block}#status{font-size:22px;font-weight:bold}</style></head><body>%s</body></html>" % (html.escape(title), body)
    ).encode()


class Handler(BaseHTTPRequestHandler):
    user = "alice"
    password = "correct-horse"

    def log_message(self, fmt, *args):  # quieter logs: one line per request
        print("%s %s" % (self.command, self.path), flush=True)

    def session_user(self):
        for part in (self.headers.get("Cookie") or "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == "shop_session" and v in SESSIONS:
                return SESSIONS[v]
        return None

    def send(self, code, body, ctype="text/html; charset=utf-8", headers=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = self.session_user()
        if self.path == "/":
            if u:
                body = "<h1>Test Shop</h1><p id='status'>Signed in as %s</p><form method='post' action='/logout'><button id='logout'>Sign out</button></form>" % html.escape(u)
            else:
                body = "<h1>Test Shop</h1><p id='status'>Not signed in</p><p><a id='login-link' href='/login'>Sign in</a></p>"
            return self.send(200, page("Test Shop", body))
        if self.path == "/login":
            body = (
                "<h1>Sign in to Test Shop</h1><form method='post' action='/login'>"
                "<label>Username <input id='username' name='username' autocomplete='username'></label>"
                "<label>Password <input id='password' name='password' type='password' autocomplete='current-password'></label>"
                "<label><input id='remember' name='remember' type='checkbox' checked> Remember me</label>"
                "<button id='submit' type='submit'>Sign in</button></form>"
            )
            return self.send(200, page("Sign in - Test Shop", body))
        if self.path == "/whoami":
            return self.send(200 if u else 401, json.dumps({"user": u}).encode(), "application/json")
        if self.path == "/sessions":
            return self.send(200, json.dumps(LOGINS).encode(), "application/json")
        return self.send(404, page("Not found", "<p>Not found</p>"))

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        form = parse_qs(self.rfile.read(n).decode())
        if self.path == "/login":
            if form.get("username", [""])[0] == self.user and form.get("password", [""])[0] == self.password:
                tok = secrets.token_urlsafe(24)
                SESSIONS[tok] = self.user
                LOGINS["count"] += 1
                cookie = "shop_session=%s; Path=/; HttpOnly; SameSite=Lax" % tok
                if "remember" in form:
                    cookie += "; Max-Age=2592000"
                return self.send(303, b"", headers={"Location": "/", "Set-Cookie": cookie})
            return self.send(401, page("Sign in failed", "<p id='status'>Wrong username or password</p><p><a href='/login'>Try again</a></p>"))
        if self.path == "/logout":
            return self.send(303, b"", headers={"Location": "/", "Set-Cookie": "shop_session=; Path=/; Max-Age=0"})
        return self.send(404, b"")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--user", default="alice")
    ap.add_argument("--password", default="correct-horse")
    a = ap.parse_args()
    Handler.user, Handler.password = a.user, a.password
    print("test shop on :%d (user %s)" % (a.port, a.user), flush=True)
    ThreadingHTTPServer(("0.0.0.0", a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
