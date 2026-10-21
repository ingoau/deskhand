#!/usr/bin/env node
/** deskhand manager entry point. */
import { parseConfig } from "./config.js";
import { createManager } from "./app.js";

async function main() {
  let cfg;
  try {
    cfg = parseConfig(process.env);
  } catch (e) {
    console.error(JSON.stringify({ level: 60, msg: `invalid configuration: ${(e as Error).message}` }));
    process.exit(2);
  }
  const m = await createManager(cfg);
  let stopping = false;
  const stop = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    m.logger.info({ signal: sig }, "shutting down (desktops keep running)");
    const t = setTimeout(() => process.exit(1), 15_000);
    t.unref();
    await m.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
  await m.listen();
}

main().catch((e) => {
  console.error(JSON.stringify({ level: 60, msg: "deskhand manager failed to start", err: (e as Error)?.message }));
  process.exit(1);
});
