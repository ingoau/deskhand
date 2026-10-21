import { afterEach, describe, expect, it, vi } from "vitest";
import { DeskhandError } from "@deskhand/shared";
import { Control } from "../../src/control.js";
import { sleep, withDeadline } from "../../src/util.js";

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof DeskhandError ? e.code : String(e);
  }
};

afterEach(() => {
  vi.useRealTimers();
});

describe("Control queue", () => {
  it("runs actions one at a time, in order", async () => {
    const c = new Control();
    const log: string[] = [];
    const job = (name: string, ms: number) =>
      c.run({}, async () => {
        log.push(`start ${name}`);
        await sleep(ms);
        log.push(`end ${name}`);
        return name;
      });
    const results = await Promise.all([job("a", 30), job("b", 5), job("c", 1)]);
    expect(results).toEqual(["a", "b", "c"]);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });
  it("keeps going after a failed action", async () => {
    const c = new Control();
    const a = c.run({}, async () => {
      throw new Error("boom");
    });
    const b = c.run({}, async () => "fine");
    await expect(a).rejects.toThrow("boom");
    await expect(b).resolves.toBe("fine");
  });
});

describe("lock and generation", () => {
  it("lock and unlock each bump the generation and record the hand-back note", () => {
    const c = new Control();
    expect(c.generation).toBe(1);
    const l = c.takeLock("dashboard");
    expect(l.generation).toBe(2);
    expect(c.lock).toMatchObject({ holder: "dashboard", generation: 2 });
    const u = c.releaseLock("logged in for you");
    expect(u.generation).toBe(3);
    expect(c.lock).toBeNull();
    expect(c.lastHandback).toMatchObject({ note: "logged in for you", generation: 3 });
  });
  it("rejects a stale generation with control_changed", async () => {
    const c = new Control();
    expect(await code(c.run({ generation: 1 }, async () => "ok"))).toBe("ok");
    c.takeLock("x");
    c.releaseLock(null);
    expect(await code(c.run({ generation: 1 }, async () => "ok"))).toBe("control_changed");
    expect(await code(c.run({ generation: 3 }, async () => "ok"))).toBe("ok");
    expect(await code(c.run({}, async () => "ok"))).toBe("ok");
  });
  it("waits for the lock and fails with locked_by_user after the wait", async () => {
    const c = new Control({ lockWaitMs: 50 });
    c.takeLock("human");
    const t0 = Date.now();
    expect(await code(c.run({}, async () => "ok"))).toBe("locked_by_user");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45);
  });
  it("a queued request proceeds when the lock is released within the wait (no generation given)", async () => {
    const c = new Control({ lockWaitMs: 1000 });
    c.takeLock("human");
    const p = c.run({}, async () => "ran");
    await sleep(20);
    c.releaseLock("done");
    await expect(p).resolves.toBe("ran");
  });
  it("a queued request that carried the old generation gets control_changed after hand-back", async () => {
    const c = new Control({ lockWaitMs: 1000 });
    const g = c.generation;
    c.takeLock("human");
    const p = c.run({ generation: g }, async () => "ran");
    await sleep(20);
    c.releaseLock(null);
    expect(await code(p)).toBe("control_changed");
  });
  it("the lock holder itself is not blocked by its own lock", async () => {
    const c = new Control({ lockWaitMs: 20 });
    c.takeLock("dashboard");
    expect(await code(c.run({ actor: "dashboard" }, async () => "ok"))).toBe("ok");
    expect(await code(c.run({ actor: "mcp:abc" }, async () => "ok"))).toBe("locked_by_user");
  });
  it("aborts a running action when control changes", async () => {
    const c = new Control();
    const p = c.run({}, async ({ signal }) => {
      await sleep(1000, signal);
      return "finished";
    });
    await sleep(20);
    c.takeLock("human");
    expect(await code(p)).toBe("control_changed");
  });
  it("checkAccess applies lock wait and generation without queueing", async () => {
    const c = new Control({ lockWaitMs: 20 });
    expect(await c.checkAccess({ generation: 1 })).toBe(1);
    c.takeLock("h");
    expect(await code(c.checkAccess({}))).toBe("locked_by_user");
  });
});

describe("withDeadline", () => {
  it("rejects with timeout even if the work never settles, and aborts its signal", async () => {
    let aborted = false;
    const p = withDeadline(
      (signal) =>
        new Promise(() => {
          signal.addEventListener("abort", () => (aborted = true));
        }),
      30,
    );
    expect(await code(p)).toBe("timeout");
    expect(aborted).toBe(true);
  });
  it("resolves with the work's value inside the deadline", async () => {
    await expect(withDeadline(async () => 42, 1000)).resolves.toBe(42);
  });
  it("propagates a parent abort (control_changed)", async () => {
    const parent = new AbortController();
    const p = withDeadline((s) => sleep(1000, s), 5000, parent.signal);
    parent.abort(new DeskhandError("control_changed"));
    expect(await code(p)).toBe("control_changed");
  });
  it("the queue moves on after a timed-out action", async () => {
    const c = new Control();
    const stuck = c.run({}, () => withDeadline(() => new Promise(() => undefined), 20));
    const next = c.run({}, async () => "next");
    expect(await code(stuck)).toBe("timeout");
    await expect(next).resolves.toBe("next");
  });
});
