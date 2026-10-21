/**
 * Template manifests (plan: "Templates" → "Descriptions"): what a saved desktop contains, computed
 * by the manager — logged-in sites from the browsers' cookie databases, installed browser
 * extensions, and Debian packages added compared with the base image.
 *
 * The probe runs inside the desktop (as the agent user, through the daemon's /exec) after quiesce,
 * so the browsers are closed and their databases flushed. It copies each cookie database to a
 * temporary directory before reading it and only ever selects cookie *metadata* (host, name,
 * expiry, flags) — cookie values are never read, returned or stored.
 */
import { DeskhandError } from "@deskhand/shared";
import type { Runtime } from "./runtime/types.js";

export interface CookieMeta {
  browser: "chromium" | "firefox";
  profile?: string;
  host: string;
  name: string;
  persistent: boolean;
  /** Unix seconds; null for session cookies. */
  expires: number | null;
  httpOnly: boolean;
}

export interface ExtensionMeta {
  browser: "chromium" | "firefox";
  id: string;
  name: string;
  version: string;
}

export interface ProbeOutput {
  cookies: CookieMeta[];
  extensions: ExtensionMeta[];
  /** "name version" for packages not in the base image's list. */
  packages: string[];
  /** False when the image has no base package list (built before phase 4). */
  baseList: boolean;
  notes: string[];
}

export interface Manifest {
  loggedInSites: string[];
  extensions: string[];
  packages: string[];
  notes: string[];
}

/** Base package list written into the desktop image at build time (`name<TAB>version`, installed only). */
export const BASE_PACKAGE_LIST = "/etc/deskhand-base-packages.txt";

// Python 3 (in every desktop image for the AT-SPI helper) has sqlite3 built in, so nothing extra is
// needed in the image. Written as a TS string: `\\t`/`\\n` reach Python as escapes.
const PROBE_PY = `
import glob, json, os, shutil, sqlite3, subprocess, tempfile
home = os.path.expanduser("~")
out = {"cookies": [], "extensions": [], "packages": [], "baseList": False, "notes": []}
tmp = tempfile.mkdtemp(prefix="deskhand-manifest-")
def rows(db, sql):
    d = tempfile.mkdtemp(dir=tmp)
    base = os.path.join(d, "db")
    shutil.copy2(db, base)
    for suf in ("-wal", "-journal"):
        if os.path.exists(db + suf):
            shutil.copy2(db + suf, base + suf)
    con = sqlite3.connect(base)
    try:
        return con.execute(sql).fetchall()
    finally:
        con.close()
def ext_name(vdir, name):
    if not (name.startswith("__MSG_") and name.endswith("__")):
        return name
    key = name[6:-2].lower()
    try:
        loc = json.load(open(os.path.join(vdir, "manifest.json"))).get("default_locale", "en")
        msgs = json.load(open(os.path.join(vdir, "_locales", loc, "messages.json")))
        for k, v in msgs.items():
            if k.lower() == key:
                return v.get("message", name)
    except Exception:
        pass
    return name
try:
    croot = os.path.join(home, ".config", "chromium")
    profs = sorted(d for d in (os.listdir(croot) if os.path.isdir(croot) else []) if d == "Default" or d.startswith("Profile "))
    for prof in profs:
        pdir = os.path.join(croot, prof)
        for db in (os.path.join(pdir, "Network", "Cookies"), os.path.join(pdir, "Cookies")):
            if os.path.isfile(db):
                try:
                    for host, name, exp, pers, ho in rows(db, "SELECT host_key, name, expires_utc, is_persistent, is_httponly FROM cookies"):
                        out["cookies"].append({"browser": "chromium", "profile": prof, "host": host, "name": name, "persistent": bool(pers),
                                               "expires": (exp / 1e6 - 11644473600) if exp else None, "httpOnly": bool(ho)})
                except Exception as e:
                    out["notes"].append("chromium %s cookies unreadable: %s" % (prof, e))
                break
        edir = os.path.join(pdir, "Extensions")
        for eid in sorted(os.listdir(edir) if os.path.isdir(edir) else []):
            if eid == "Temp":
                continue
            try:
                vers = sorted(os.listdir(os.path.join(edir, eid)))
                vdir = os.path.join(edir, eid, vers[-1])
                m = json.load(open(os.path.join(vdir, "manifest.json")))
                out["extensions"].append({"browser": "chromium", "id": eid, "name": ext_name(vdir, m.get("name", eid)), "version": m.get("version", "")})
            except Exception as e:
                out["notes"].append("chromium extension %s unreadable: %s" % (eid, e))
    for prof in sorted(glob.glob(os.path.join(home, ".mozilla", "firefox", "*", ""))):
        pname = os.path.basename(os.path.dirname(prof))
        db = os.path.join(prof, "cookies.sqlite")
        if os.path.isfile(db):
            try:
                for host, name, exp, ho in rows(db, "SELECT host, name, expiry, isHttpOnly FROM moz_cookies"):
                    e = float(exp or 0)
                    if e > 1e11:
                        e = e / 1000.0
                    out["cookies"].append({"browser": "firefox", "profile": pname, "host": host, "name": name, "persistent": True,
                                           "expires": e or None, "httpOnly": bool(ho)})
            except Exception as e:
                out["notes"].append("firefox %s cookies unreadable: %s" % (pname, e))
        ej = os.path.join(prof, "extensions.json")
        if os.path.isfile(ej):
            try:
                for a in json.load(open(ej)).get("addons", []):
                    if a.get("type") == "extension" and a.get("location") == "app-profile":
                        out["extensions"].append({"browser": "firefox", "id": a.get("id", ""), "name": (a.get("defaultLocale") or {}).get("name") or a.get("id", ""), "version": a.get("version", "")})
            except Exception as e:
                out["notes"].append("firefox %s extensions unreadable: %s" % (pname, e))
    basef = "${BASE_PACKAGE_LIST}"
    if os.path.isfile(basef):
        base = set(l.split("\\t")[0] for l in open(basef) if l.strip())
        out["baseList"] = True
        cur = subprocess.run(["dpkg-query", "-W", "-f=\${Package}\\t\${Version}\\t\${db:Status-Status}\\n"], capture_output=True, text=True).stdout
        for l in cur.splitlines():
            p = l.split("\\t")
            if len(p) == 3 and p[2] == "installed" and p[0] not in base:
                out["packages"].append("%s %s" % (p[0], p[1]))
    else:
        out["notes"].append("the base image has no package list (%s), so added packages are not listed" % basef)
finally:
    shutil.rmtree(tmp, ignore_errors=True)
print(json.dumps(out))
`;

/** The exec command (the first line marks it for the fake daemon in tests). */
export const PROBE_COMMAND = `# deskhand-manifest\npython3 - <<'DESKHAND_PY'\n${PROBE_PY}\nDESKHAND_PY\n`;

// ---------------------------------------------------------------- classification

/** Cookie names that never indicate a login: analytics, ads, consent, load balancers, preferences. */
const NOT_LOGIN =
  /^(_ga|_gid|_gat|_gcl_|__utm|_hj|_clck|_clsk|_fbp|_fbc|_uet|_pin_|_tt_|_scid|_rdt_|ajs_|amplitude|mp_|optimizely|_dd_s|__stripe_|__cf_bm|cf_clearance|_cfuvid|nid$|1p_jar$|aec$|otz$|consent|socs$|euconsent|optanon|cookieconsent|cookie_consent|cookielawinfo|test_cookie$|ide$|ysc$|visitor_info|pref$|lang$|locale$|i18n|theme$|tz$|timezone$|preferred_color_mode$|color_mode$|awsalb|awselb|_octo$)/i;
/** Cookie names that typically carry a login session. */
const LOGIN_NAME =
  /(sess|sid$|^sid|auth|token|login|logged|user|uid$|remember|jwt|account|ident|^__host-|^__secure-|^li_at$|^c_user$|^xs$|^sapisid$|^ssid$|^hsid$|^apisid$|^lsid$)/i;

/** Two-label public suffixes common enough to matter (co.uk, com.au...). Not a full PSL. */
const SECOND_LEVEL = new Set(["co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go"]);

/** "accounts.github.com" → "github.com", ".bbc.co.uk" → "bbc.co.uk"; IPs and single labels unchanged. */
export function registrableDomain(host: string): string {
  const h = host.replace(/^\.+/, "").replace(/\.$/, "").toLowerCase();
  if (!h.includes(".") || /^[\d.]+$/.test(h) || h.includes(":")) return h;
  const parts = h.split(".");
  if (parts.length <= 2) return h;
  const tld = parts[parts.length - 1]!;
  const sld = parts[parts.length - 2]!;
  const n = tld.length === 2 && SECOND_LEVEL.has(sld) ? 3 : 2;
  return parts.slice(-n).join(".");
}

/**
 * Sites with a login that survives a restart: an unexpired persistent cookie that is not a known
 * tracking/preference cookie and either has a login-like name or is HttpOnly (set by the server,
 * not by page scripts). Sorted, one entry per registrable domain.
 */
export function loggedInSites(cookies: CookieMeta[], nowSec = Date.now() / 1000): string[] {
  const sites = new Set<string>();
  for (const c of cookies) {
    if (!c.persistent || c.expires === null || c.expires <= nowSec) continue;
    if (NOT_LOGIN.test(c.name)) continue;
    if (!LOGIN_NAME.test(c.name) && !c.httpOnly) continue;
    const d = registrableDomain(c.host);
    if (d) sites.add(d);
  }
  return [...sites].sort();
}

export function extensionLabels(exts: ExtensionMeta[]): string[] {
  const seen = new Set<string>();
  for (const e of exts) seen.add(`${e.browser === "firefox" ? "Firefox: " : ""}${e.name}${e.version ? ` ${e.version}` : ""}`);
  return [...seen].sort((a, b) => a.localeCompare(b));
}

export function parseProbe(stdout: string): ProbeOutput {
  const line = stdout.trim().split("\n").pop() ?? "";
  const j = JSON.parse(line) as Partial<ProbeOutput>;
  return {
    cookies: Array.isArray(j.cookies) ? j.cookies : [],
    extensions: Array.isArray(j.extensions) ? j.extensions : [],
    packages: Array.isArray(j.packages) ? j.packages : [],
    baseList: !!j.baseList,
    notes: Array.isArray(j.notes) ? j.notes : [],
  };
}

export function manifestFrom(p: ProbeOutput, nowSec = Date.now() / 1000): Manifest {
  return { loggedInSites: loggedInSites(p.cookies, nowSec), extensions: extensionLabels(p.extensions), packages: [...p.packages].sort(), notes: p.notes };
}

/**
 * Runs the probe in a running desktop container as the agent user (docker exec, so it is not
 * subject to the takeover lock and does not show up as an agent action). Never throws for a probe
 * failure: returns an empty manifest with a note.
 */
export async function computeManifest(runtime: Runtime, containerId: string, uid: number, gid: number): Promise<Manifest> {
  try {
    const r = await runtime.exec(containerId, ["bash", "-c", PROBE_COMMAND], {
      user: `${uid}:${gid}`,
      env: ["HOME=/home/agent", "USER=agent", "LANG=C.UTF-8"],
      workdir: "/home/agent",
      timeoutMs: 60_000,
    });
    if (r.exitCode !== 0) throw new DeskhandError("internal", `manifest probe exited ${r.exitCode}: ${r.stderr.slice(-300)}`);
    return manifestFrom(parseProbe(r.stdout));
  } catch (e) {
    const err = e as DeskhandError;
    const why = err.details && typeof err.details === "object" && "cause" in err.details ? String((err.details as { cause: unknown }).cause) : err.message;
    return { loggedInSites: [], extensions: [], packages: [], notes: [`manifest could not be computed: ${why}`] };
  }
}
