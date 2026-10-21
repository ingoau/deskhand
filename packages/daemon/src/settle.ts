/**
 * Settle detection: after input, wait until the screen has been unchanged for `quietMs`
 * (default 300 ms), but no longer than `capMs` (default 3 s). Returns the last frame so the
 * caller can encode it without capturing again.
 */
import { sleep } from "./util.js";

export interface SettleOptions<F> {
  grab: () => Promise<F>;
  same: (a: F, b: F) => boolean;
  quietMs?: number;
  capMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

export interface SettleResult<F> {
  frame: F;
  settled: boolean;
  waitedMs: number;
  frames: number;
}

export const SETTLE_DEFAULTS = { quietMs: 300, capMs: 3000, intervalMs: 50 } as const;

export async function waitForSettle<F>(o: SettleOptions<F>): Promise<SettleResult<F>> {
  const quietMs = o.quietMs ?? SETTLE_DEFAULTS.quietMs;
  const capMs = o.capMs ?? SETTLE_DEFAULTS.capMs;
  const intervalMs = o.intervalMs ?? SETTLE_DEFAULTS.intervalMs;
  const now = o.now ?? (() => performance.now());
  const doSleep = o.sleep ?? sleep;
  const start = now();
  let prev = await o.grab();
  let frames = 1;
  let lastChange = start;
  for (;;) {
    const t = now();
    if (t - lastChange >= quietMs) return { frame: prev, settled: true, waitedMs: t - start, frames };
    if (t - start >= capMs) return { frame: prev, settled: false, waitedMs: t - start, frames };
    await doSleep(intervalMs, o.signal);
    const cur = await o.grab();
    frames++;
    if (!o.same(prev, cur)) lastChange = now();
    prev = cur;
  }
}
