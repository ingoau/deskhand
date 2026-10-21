/**
 * The `deskhand` command: a thin client of the manager's HTTP API.
 *
 * Credentials, in order: --token/--url flags, DESKHAND_TOKEN/DESKHAND_URL, then the admin
 * credential the manager writes to <DESKHAND_DATA_DIR>/admin.json (0600) on every start —
 * which is what `docker compose exec deskhand deskhand …` uses inside the manager container.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

export interface Io {
  env: Record<string, string | undefined>;
  stdout: { write(s: string | Uint8Array): unknown; isTTY?: boolean };
  stderr: { write(s: string): unknown };
}

const USAGE = `deskhand — isolated Linux desktops for AI agents

Usage: deskhand [--url URL] [--token TOKEN] <command>

Desktops
  ls [--json]                       List desktops
  screenshot [desktop] > shot.png   PNG of a desktop (default: the only running one)
  start <desktop>                   Start a stopped desktop
  stop <desktop>                    Stop a desktop (files kept)
  rm <desktop>                      Remove a desktop

Access
  login-link                        Print a one-time dashboard login link (5 minutes)
  token create <name>               Create an API token for an agent host (shown once)
  token ls                          List API tokens
  token revoke <name|id>            Revoke a token

Templates
  template ls                       List templates
  template info <name>              Show a template's description and versions
  template rollback <name> [ver]    Point a template back at an earlier version (default: the previous one)
  template edit <name>              Start a persistent desktop from a template to change it
  template rebuild <name>           Replay the recipe on the current base image (new version)
  template recipe <name> [file|-]   Show, or set from a file / stdin (--clear removes it)
  template diff <name> [from] [to]  What changed between two versions
  build                             Build the desktop image locally (not available yet)

Credentials: --token/--url, DESKHAND_TOKEN/DESKHAND_URL, or <DESKHAND_DATA_DIR>/admin.json
(written by the manager; used automatically inside the manager container).`;

class CliError extends Error {}

interface Creds {
  url: string;
  token: string | null;
  /** The address users reach (printed in hints); differs from url inside the compose container. */
  publicUrl: string;
}

export function resolveCreds(flags: { url?: string; token?: string }, env: Io["env"]): Creds {
  const url = flags.url ?? env.DESKHAND_URL;
  const token = flags.token ?? env.DESKHAND_TOKEN;
  if (token) {
    const u = (url ?? "http://127.0.0.1:7480").replace(/\/+$/, "");
    return { url: u, token, publicUrl: u };
  }
  const file = path.join(env.DESKHAND_DATA_DIR ?? "/data", "admin.json");
  try {
    const admin = JSON.parse(fs.readFileSync(file, "utf8")) as { url: string; token: string; publicUrl?: string };
    const u = (url ?? admin.url).replace(/\/+$/, "");
    return { url: u, token: admin.token, publicUrl: url ? u : (admin.publicUrl ?? admin.url).replace(/\/+$/, "") };
  } catch {
    const u = (url ?? "http://127.0.0.1:7480").replace(/\/+$/, "");
    return { url: u, token: null, publicUrl: u };
  }
}

async function call(creds: Creds, method: string, p: string, body?: unknown): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${creds.url}${p}`, {
      method,
      headers: {
        ...(creds.token ? { authorization: `Bearer ${creds.token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new CliError(`cannot reach the deskhand manager at ${creds.url} (${(e as Error).message})`);
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = (await res.json()) as { error?: { code: string; message: string } };
      if (j.error) msg = `${j.error.message} (${j.error.code})`;
    } catch {
      /* not json */
    }
    if (res.status === 401 && !creds.token) msg += " — pass --token or set DESKHAND_TOKEN (or run inside the manager container)";
    throw new CliError(msg);
  }
  return res;
}

async function json<T>(creds: Creds, method: string, p: string, body?: unknown): Promise<T> {
  const res = await call(creds, method, p, body);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function table(rows: string[][]): string {
  if (!rows.length) return "";
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join("  ").trimEnd()).join("\n") + "\n";
}

function ago(iso: string | null): string {
  if (!iso) return "-";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function mb(n: number | null): string {
  return n === null ? "-" : `${Math.round(n / 1024 / 1024)}M`;
}

interface Desktop {
  id: string;
  title: string | null;
  status: string;
  template: string;
  templateVersion: number;
  session: string | null;
  persistent: boolean;
  lock: unknown;
  attention: unknown;
  createdAt: string;
  cpuPercent: number | null;
  memoryBytes: number | null;
}

interface TemplateRow {
  name: string;
  currentVersion: number;
  latestVersion: number;
  isDefault: boolean;
  stale: boolean;
  staleReason?: string | null;
  outdatedBase: boolean;
  recentlyChangedByAgent: boolean;
  loggedInSites: string[];
  extensions?: string[];
  baseVersion?: string;
  currentBaseVersion?: string;
  hasRecipe?: boolean;
  lastFeedback: { kind: string; note: string; at: string; version: number } | null;
  lastConfirmedAt: string | null;
  rebuild?: { status: string; at: string; error: string | null } | null;
  description: { summary: string; use_when: string; not_for?: string; setup_notes?: string; tags?: string[] };
}

interface VersionRow {
  version: number;
  createdAt: string;
  savedBy: string | null;
  byAgent: boolean;
  rebuiltFrom?: number | null;
  loggedInSites: string[];
  packages: string[];
  inUse: number;
}

type Changes = Record<string, unknown>;

function flags(t: TemplateRow): string {
  return [
    t.isDefault ? "default" : "",
    t.stale ? "stale" : "",
    t.outdatedBase ? "outdated-base" : "",
    t.recentlyChangedByAgent ? "changed-by-agent" : "",
    t.hasRecipe ? "recipe" : "",
    t.rebuild && t.rebuild.status !== "ok" ? `rebuild-${t.rebuild.status}` : "",
  ]
    .filter(Boolean)
    .join(",");
}

export async function run(argv: string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { url: { type: "string" }, token: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" } },
    });
  } catch (e) {
    io.stderr.write(`${(e as Error).message}\n\n${USAGE}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [cmd, sub, a1, a2] = positionals;
  if (values.help || !cmd || cmd === "help") {
    io.stdout.write(USAGE + "\n");
    return cmd || values.help ? 0 : 2;
  }
  const creds = resolveCreds(values, io.env);
  const out = (s: string) => io.stdout.write(s);
  const need = (v: string | undefined, what: string) => {
    if (!v) throw new CliError(`missing ${what}`);
    return v;
  };
  try {
    switch (cmd) {
      case "version": {
        const h = await json<{ version: string }>(creds, "GET", "/healthz");
        out(`manager ${h.version}\n`);
        return 0;
      }
      case "ls": {
        const { desktops } = await json<{ desktops: Desktop[] }>(creds, "GET", "/api/desktops");
        if (values.json) {
          out(JSON.stringify(desktops, null, 2) + "\n");
          return 0;
        }
        if (!desktops.length) {
          out("no desktops\n");
          return 0;
        }
        const rows = [["ID", "STATUS", "TEMPLATE", "TITLE", "SESSION", "CPU", "MEM", "AGE"]];
        for (const d of desktops) {
          const status = d.attention ? "attention" : d.lock ? "locked" : d.status;
          rows.push([d.id, status + (d.persistent ? "*" : ""), `${d.template}:v${d.templateVersion}`, d.title ?? "-", d.session ?? "-", d.cpuPercent === null ? "-" : `${d.cpuPercent}%`, mb(d.memoryBytes), ago(d.createdAt)]);
        }
        out(table(rows));
        return 0;
      }
      case "screenshot": {
        let id = sub;
        if (!id) {
          const { desktops } = await json<{ desktops: Desktop[] }>(creds, "GET", "/api/desktops");
          const running = desktops.filter((d) => d.status === "running");
          if (running.length !== 1) throw new CliError(running.length ? `several desktops are running; pass one of: ${running.map((d) => d.id).join(", ")}` : "no desktop is running");
          id = running[0]!.id;
        }
        if (io.stdout.isTTY) throw new CliError("refusing to write a PNG to the terminal; redirect it: deskhand screenshot > shot.png");
        const res = await call(creds, "GET", `/api/desktops/${encodeURIComponent(id)}/screenshot?format=png`);
        io.stdout.write(new Uint8Array(await res.arrayBuffer()));
        return 0;
      }
      case "start":
      case "stop": {
        const d = await json<Desktop>(creds, "POST", `/api/desktops/${encodeURIComponent(need(sub, "desktop id"))}/${cmd}`);
        out(`${d.id} ${d.status}\n`);
        return 0;
      }
      case "rm": {
        await json(creds, "DELETE", `/api/desktops/${encodeURIComponent(need(sub, "desktop id"))}`);
        out(`${sub} removed\n`);
        return 0;
      }
      case "login-link": {
        const r = await json<{ url: string; expiresAt: string }>(creds, "POST", "/api/login-links");
        out(`${r.url}\n`);
        io.stderr.write(`(single use, valid until ${r.expiresAt})\n`);
        return 0;
      }
      case "token": {
        if (sub === "create") {
          const r = await json<{ token: { name: string }; secret: string }>(creds, "POST", "/api/tokens", { name: need(a1, "token name") });
          out(`${r.secret}\n`);
          io.stderr.write(
            `Token "${r.token.name}" created; it is shown only once.\nConnect an agent host:\n  claude mcp add --transport http deskhand ${creds.publicUrl}/mcp --header "Authorization: Bearer ${r.secret}"\n`,
          );
          return 0;
        }
        if (sub === "ls") {
          const { tokens } = await json<{ tokens: Array<{ id: string; name: string; createdAt: string; lastUsedAt: string | null }> }>(creds, "GET", "/api/tokens");
          if (values.json) out(JSON.stringify(tokens, null, 2) + "\n");
          else out(tokens.length ? table([["ID", "NAME", "CREATED", "LAST USED"], ...tokens.map((t) => [t.id, t.name, ago(t.createdAt), t.lastUsedAt ? ago(t.lastUsedAt) : "never"])]) : "no tokens\n");
          return 0;
        }
        if (sub === "revoke") {
          await json(creds, "DELETE", `/api/tokens/${encodeURIComponent(need(a1, "token name or id"))}`);
          out(`revoked ${a1}\n`);
          return 0;
        }
        throw new CliError("usage: deskhand token create <name> | ls | revoke <name|id>");
      }
      case "template": {
        if (sub === "ls") {
          const { templates } = await json<{ templates: TemplateRow[] }>(creds, "GET", "/api/templates");
          if (values.json) out(JSON.stringify(templates, null, 2) + "\n");
          else
            out(
              table([
                ["NAME", "VERSION", "FLAGS", "LOGGED IN", "SUMMARY"],
                ...templates.map((t) => [
                  t.name,
                  t.currentVersion === t.latestVersion ? `v${t.currentVersion}` : `v${t.currentVersion} (latest v${t.latestVersion})`,
                  flags(t) || "-",
                  t.loggedInSites.join(",") || "-",
                  t.description.summary,
                ]),
              ]),
            );
          return 0;
        }
        if (sub === "info") {
          const t = await json<TemplateRow & { versions: VersionRow[]; recipe: string | null }>(creds, "GET", `/api/templates/${encodeURIComponent(need(a1, "template name"))}`);
          if (values.json) {
            out(JSON.stringify(t, null, 2) + "\n");
            return 0;
          }
          const d = t.description;
          const lines = [
            `${t.name}  v${t.currentVersion}${t.currentVersion !== t.latestVersion ? ` (latest v${t.latestVersion})` : ""}  ${flags(t)}`,
            `summary:     ${d.summary}`,
            `use when:    ${d.use_when}`,
            ...(d.not_for ? [`not for:     ${d.not_for}`] : []),
            ...(d.setup_notes ? [`setup notes: ${d.setup_notes}`] : []),
            ...(d.tags?.length ? [`tags:        ${d.tags.join(", ")}`] : []),
            `logged in:   ${t.loggedInSites.join(", ") || "-"}`,
            `extensions:  ${t.extensions?.join(", ") || "-"}`,
            `base:        ${t.baseVersion ?? "-"}${t.outdatedBase ? `  (outdated; current base ${t.currentBaseVersion})` : ""}`,
            `recipe:      ${t.recipe ? `${t.recipe.split("\n").length} lines` : "none"}${t.rebuild ? `  (last rebuild ${t.rebuild.status} ${ago(t.rebuild.at)} ago${t.rebuild.error ? `: ${t.rebuild.error.split("\n")[0]}` : ""})` : ""}`,
            `feedback:    ${t.lastFeedback ? `${t.lastFeedback.kind} on v${t.lastFeedback.version} ${ago(t.lastFeedback.at)} ago: ${t.lastFeedback.note}` : "-"}  (last confirmed ${t.lastConfirmedAt ? `${ago(t.lastConfirmedAt)} ago` : "never"})`,
            "",
            "versions:",
            ...t.versions.map(
              (v) =>
                `  v${v.version}${v.version === t.currentVersion ? "*" : " "} ${v.createdAt.slice(0, 16).replace("T", " ")}  by ${v.savedBy ?? "-"}${v.byAgent ? " (agent)" : ""}${v.rebuiltFrom ? ` rebuilt from v${v.rebuiltFrom}` : ""}  sites: ${v.loggedInSites.join(",") || "-"}  packages: ${v.packages.length}  in use: ${v.inUse}`,
            ),
          ];
          out(lines.join("\n") + "\n");
          return 0;
        }
        if (sub === "rollback") {
          const name = need(a1, "template name");
          let body: { version?: number } = {};
          if (a2) {
            const version = Number(a2.replace(/^v/, ""));
            if (!Number.isInteger(version)) throw new CliError("version must be a number, e.g. 3 or v3");
            body = { version };
          }
          const t = await json<{ currentVersion: number }>(creds, "POST", `/api/templates/${encodeURIComponent(name)}/rollback`, body);
          out(`${name} now points at v${t.currentVersion}\n`);
          return 0;
        }
        if (sub === "rebuild") {
          const name = need(a1, "template name");
          io.stderr.write(`Rebuilding ${name} on the current base image (replays its recipe; can take minutes)…\n`);
          const r = await json<{ version: number; template: TemplateRow }>(creds, "POST", `/api/templates/${encodeURIComponent(name)}/rebuild`);
          out(`${name} rebuilt as v${r.version} (logged in: ${r.template.loggedInSites.join(", ") || "-"})\n`);
          return 0;
        }
        if (sub === "recipe") {
          const name = need(a1, "template name");
          if (!a2) {
            const t = await json<{ recipe: string | null }>(creds, "GET", `/api/templates/${encodeURIComponent(name)}`);
            out(t.recipe ? (t.recipe.endsWith("\n") ? t.recipe : `${t.recipe}\n`) : "");
            if (!t.recipe) io.stderr.write(`${name} has no recipe\n`);
            return 0;
          }
          const recipe = a2 === "--clear" || a2 === "none" ? null : fs.readFileSync(a2 === "-" ? 0 : a2, "utf8");
          await json(creds, "PUT", `/api/templates/${encodeURIComponent(name)}/recipe`, { recipe });
          out(recipe ? `${name}: recipe updated (${recipe.split("\n").length} lines)\n` : `${name}: recipe removed\n`);
          return 0;
        }
        if (sub === "diff") {
          const name = need(a1, "template name");
          const q = new URLSearchParams();
          if (a2) q.set("from", a2.replace(/^v/, ""));
          if (positionals[4]) q.set("to", positionals[4].replace(/^v/, ""));
          const d = await json<Changes>(creds, "GET", `/api/templates/${encodeURIComponent(name)}/diff${q.size ? `?${q}` : ""}`);
          out(JSON.stringify(d, null, 2) + "\n");
          return 0;
        }
        if (sub === "edit") {
          const name = need(a1, "template name");
          const d = await json<Desktop>(creds, "POST", "/api/desktops", { template: name, name: `edit-${name}`, persistent: true });
          out(`${d.id}\n`);
          io.stderr.write(
            `Started persistent desktop ${d.id} from template ${name}. Open it in the dashboard (${creds.publicUrl}/desktops/${d.id}), take over, make your changes, then use "Save as template" with the name "${name}" to save a new version. Remove it afterwards with: deskhand rm ${d.id}\n`,
          );
          return 0;
        }
        throw new CliError("usage: deskhand template ls | info <name> | rollback <name> [version] | edit <name> | rebuild <name> | recipe <name> [file|-|--clear] | diff <name> [from] [to]");
      }
      case "build":
        throw new CliError("`deskhand build` is not available yet; build the desktop image with docker build -f images/desktop/Dockerfile -t deskhand-desktop:dev . from the repo.");
      default:
        throw new CliError(`unknown command "${cmd}"\n\n${USAGE}`);
    }
  } catch (e) {
    if (e instanceof CliError) {
      io.stderr.write(`deskhand: ${e.message}\n`);
      return 1;
    }
    io.stderr.write(`deskhand: ${(e as Error).message}\n`);
    return 1;
  }
}
