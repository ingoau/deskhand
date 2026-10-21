import { describe, expect, it } from "vitest";
import { waitForSettle } from "../../src/settle.js";

/** A fake clock + frame source: frames[i] is shown from times[i] on. */
function scenario(changesAt: number[]) {
  let t = 0;
  const frameAt = (time: number) => changesAt.filter((c) => c <= time).length;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    grab: async () => frameAt(t),
    same: (a: number, b: number) => a === b,
  };
}

describe("waitForSettle", () => {
  it("returns after ~300 ms when the screen is static", async () => {
    const s = scenario([]);
    const r = await waitForSettle({ ...s });
    expect(r.settled).toBe(true);
    expect(r.waitedMs).toBeGreaterThanOrEqual(300);
    expect(r.waitedMs).toBeLessThan(400);
  });
  it("waits for changes to stop, then 300 ms more", async () => {
    const s = scenario([100, 200, 450]);
    const r = await waitForSettle({ ...s });
    expect(r.settled).toBe(true);
    expect(r.frame).toBe(3);
    expect(r.waitedMs).toBeGreaterThanOrEqual(750);
    expect(r.waitedMs).toBeLessThan(850);
  });
  it("gives up at the cap and flags unsettled when the screen keeps changing", async () => {
    const s = scenario(Array.from({ length: 200 }, (_, i) => i * 40));
    const r = await waitForSettle({ ...s });
    expect(r.settled).toBe(false);
    expect(r.waitedMs).toBeGreaterThanOrEqual(3000);
    expect(r.waitedMs).toBeLessThan(3100);
  });
  it("honours custom quiet and cap", async () => {
    const s = scenario([]);
    const r = await waitForSettle({ ...s, quietMs: 100, capMs: 50 });
    expect(r.settled).toBe(false);
    expect(r.waitedMs).toBeLessThan(100);
  });
  it("stops when the signal aborts", async () => {
    const c = new AbortController();
    c.abort(new Error("stop"));
    let t = 0;
    await expect(
      waitForSettle({
        grab: async () => t++,
        same: () => false,
        signal: c.signal,
      }),
    ).rejects.toThrow("stop");
  });
});
