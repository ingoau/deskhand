import crypto from "node:crypto";

const DURATION_UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** "30m", "24h", "7d", "1h30m", "500ms", "90" (seconds) -> milliseconds. */
export function parseDuration(input: string): number {
  const s = input.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const re = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)/g;
  let total = 0;
  let consumed = 0;
  for (const m of s.matchAll(re)) {
    total += Number(m[1]) * DURATION_UNITS[m[2]!]!;
    consumed += m[0].length;
  }
  if (consumed === 0 || consumed !== s.replace(/\s+/g, "").length) throw new Error(`invalid duration "${input}"`);
  return Math.round(total);
}

export function formatDuration(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000} day${ms === 86_400_000 ? "" : "s"}`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} hour${ms === 3_600_000 ? "" : "s"}`;
  if (ms % 60_000 === 0) return `${ms / 60_000} minute${ms === 60_000 ? "" : "s"}`;
  const s = Math.max(1, Math.round(ms / 1000));
  return `${s} second${s === 1 ? "" : "s"}`;
}

const BYTE_UNITS: Record<string, number> = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };

/** Docker-style sizes: "2g", "512m", "1.5G", "2gb", "1024" (bytes). */
export function parseBytes(input: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([bkmgt])?(?:i?b)?$/i.exec(input.trim());
  if (!m) throw new Error(`invalid size "${input}"`);
  return Math.round(Number(m[1]) * BYTE_UNITS[(m[2] ?? "b").toLowerCase()]!);
}

export function randomId(bytes = 4): string {
  return crypto.randomBytes(bytes).toString("hex");
}

export function secret(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Serialises async work per key. */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}

/** Normalises a base path: "" or "/a/b" (leading slash, no trailing slash). */
export function normalizeBasePath(input: string | undefined): string {
  if (!input) return "";
  let p = input.trim();
  if (!p || p === "/") return "";
  if (!p.startsWith("/")) p = "/" + p;
  p = p.replace(/\/+$/, "").replace(/\/{2,}/g, "/");
  if (!/^[A-Za-z0-9._~\-/]+$/.test(p)) throw new Error(`invalid DESKHAND_BASE_PATH "${input}"`);
  return p;
}
