/** deskhand control daemon entry point (runs as root under supervisord inside the desktop). */
import { readFileSync } from "node:fs";
import { DAEMON_API_VERSION, DAEMON_PORT, DESKHAND_VERSION } from "@deskhand/shared";
import { Desktop } from "./desktop.js";
import { log } from "./log.js";
import { createServer } from "./server.js";

const KEY_FILE = process.env.DESKHAND_KEY_FILE ?? "/run/deskhand/key";
const PORT = Number(process.env.DESKHAND_DAEMON_PORT ?? DAEMON_PORT);
const HOST = process.env.DESKHAND_DAEMON_HOST ?? "0.0.0.0";

let key: string | null = null;
function loadKey(): string | null {
  try {
    const k = readFileSync(KEY_FILE, "utf8").trim();
    key = k.length > 0 ? k : null;
  } catch {
    key = null;
  }
  return key;
}
loadKey();
if (!key) log.error("no daemon key; every authenticated request will be refused", { keyFile: KEY_FILE });

const desktop = new Desktop({
  lockWaitMs: process.env.DESKHAND_LOCK_WAIT_MS ? Number(process.env.DESKHAND_LOCK_WAIT_MS) : undefined,
  stuckButtonMs: process.env.DESKHAND_STUCK_BUTTON_MS ? Number(process.env.DESKHAND_STUCK_BUTTON_MS) : undefined,
});

// Connect to X in the background; requests that need it wait or get daemon_unavailable.
desktop.x(60_000).catch((e) => log.error("X not available at start", { error: String(e?.message ?? e) }));

const server = createServer({ desktop, key: () => key ?? loadKey() });
server.listen(PORT, HOST, () => log.info("daemon listening", { host: HOST, port: PORT, version: DESKHAND_VERSION, apiVersion: DAEMON_API_VERSION }));

const shutdown = (sig: string) => {
  log.info("shutting down", { signal: sig });
  desktop.releaseAll().catch(() => undefined);
  server.close();
  setTimeout(() => process.exit(0), 500).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (e) => log.error("unhandled rejection", { error: String((e as Error)?.stack ?? e) }));
