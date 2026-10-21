/** Compact, monospace-friendly formatting used throughout the dashboard. */

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const pad2 = (n: number) => String(n).padStart(2, "0");

export function toMs(t: string | number | Date | null | undefined): number | null {
  if (t == null) return null;
  if (typeof t === "number") return t;
  const ms = t instanceof Date ? t.getTime() : Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Uptime / duration in the tile style:
 *   under a minute: `0:04`; under an hour: `18m`; under a day: `1h05m`; longer: `3d04h`.
 */
export function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  if (ms < MIN) return `0:${pad2(Math.floor(ms / SEC))}`;
  if (ms < HOUR) return `${Math.floor(ms / MIN)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h${pad2(Math.floor((ms % HOUR) / MIN))}m`;
  return `${Math.floor(ms / DAY)}d${pad2(Math.floor((ms % DAY) / HOUR))}h`;
}

/** Short relative age without "ago": `now`, `12s`, `2m`, `3h`, `2d`, `5w`. */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  if (ms < 5 * SEC) return "now";
  if (ms < MIN) return `${Math.floor(ms / SEC)}s`;
  if (ms < HOUR) return `${Math.floor(ms / MIN)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  if (ms < 14 * DAY) return `${Math.floor(ms / DAY)}d`;
  return `${Math.floor(ms / (7 * DAY))}w`;
}

/** `2m` since `iso`, relative to `now`. */
export function since(iso: string | null | undefined, now: number): string {
  const t = toMs(iso);
  return t == null ? "—" : formatAge(now - t);
}

/** `ago` form for lists: `2m ago`, `just now`. */
export function ago(iso: string | null | undefined, now: number): string {
  const t = toMs(iso);
  if (t == null) return "never";
  const s = formatAge(now - t);
  return s === "now" ? "just now" : `${s} ago`;
}

/** Remaining time until `iso`: `8m`, or null if in the past/unknown. */
export function until(iso: string | null | undefined, now: number): string | null {
  const t = toMs(iso);
  if (t == null || t <= now) return null;
  const left = t - now;
  if (left < MIN) return `${Math.ceil(left / SEC)}s`;
  if (left < HOUR) return `${Math.ceil(left / MIN)}m`;
  return formatUptime(left);
}

/** Bytes as `9.8G`, `512M`, `40K`. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  const units = ["B", "K", "M", "G", "T"];
  let v = Math.max(0, bytes);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  if (i === 0) return `${Math.round(v)}B`;
  return `${v >= 10 || i < 3 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, "")}${units[i]}`;
}

/** `21:14:09` local time. */
export function clock(iso: string | null | undefined): string {
  const t = toMs(iso);
  if (t == null) return "--:--:--";
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** `2026-10-21 21:14` local. */
export function dateTime(iso: string | null | undefined): string {
  const t = toMs(iso);
  if (t == null) return "—";
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** `340ms`, `1.2s`, `2m05s`. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "";
  if (ms < SEC) return `${Math.round(ms)}ms`;
  if (ms < 10 * SEC) return `${(ms / SEC).toFixed(1)}s`;
  if (ms < MIN) return `${Math.round(ms / SEC)}s`;
  return `${Math.floor(ms / MIN)}m${pad2(Math.round((ms % MIN) / SEC))}s`;
}

/** `1280×800` */
export function screenLabel(screen: { width: number; height: number }): string {
  return `${screen.width}×${screen.height}`;
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + "…";
}
