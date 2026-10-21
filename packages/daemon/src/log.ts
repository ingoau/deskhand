/** Structured JSON logs on stdout (one object per line), collected by supervisord → docker logs. */
type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = LEVELS[(process.env.DESKHAND_LOG_LEVEL as Level) ?? "info"] ?? 20;

function write(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < min) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, src: "daemon", msg, ...fields });
  process.stdout.write(line + "\n");
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => write("debug", msg, f),
  info: (msg: string, f?: Record<string, unknown>) => write("info", msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => write("warn", msg, f),
  error: (msg: string, f?: Record<string, unknown>) => write("error", msg, f),
};
