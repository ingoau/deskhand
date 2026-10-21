/** The agent user and the desktop session environment (written by deskhand-entrypoint). */
import { readFileSync } from "node:fs";

export interface AgentUser {
  uid: number;
  gid: number;
  home: string;
}

let cachedUser: AgentUser | null = null;

export function agentUser(): AgentUser {
  if (cachedUser) return cachedUser;
  try {
    const line = readFileSync("/etc/passwd", "utf8")
      .split("\n")
      .find((l) => l.startsWith("agent:"));
    if (line) {
      const f = line.split(":");
      cachedUser = { uid: Number(f[2]), gid: Number(f[3]), home: f[5] || "/home/agent" };
      return cachedUser;
    }
  } catch {
    /* fall through */
  }
  // Not in a desktop image (unit tests, dev): run as ourselves.
  cachedUser = { uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000, home: process.env.HOME ?? "/tmp" };
  return cachedUser;
}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/** Environment for processes run as the agent (exec, ui-tree helper, Chromium launch). */
export function sessionEnv(): Record<string, string> {
  let env: Record<string, string> = {};
  try {
    env = parseEnvFile(readFileSync("/run/deskhand/session.env", "utf8"));
  } catch {
    const u = agentUser();
    env = {
      DISPLAY: process.env.DISPLAY ?? ":0",
      HOME: u.home,
      USER: "agent",
      PATH: "/usr/local/bin:/usr/bin:/bin",
      LANG: process.env.LANG ?? "C.UTF-8",
    };
    if (process.env.DBUS_SESSION_BUS_ADDRESS) env.DBUS_SESSION_BUS_ADDRESS = process.env.DBUS_SESSION_BUS_ADDRESS;
  }
  // Never pass the daemon key or anything else from our own environment.
  return env;
}
