import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pino } from "pino";
import { ActionLog } from "../src/actionlog.js";
import { openDb } from "../src/db.js";
import { makePng } from "../src/fake-daemon/fake-daemon.js";
import { encodeForAgent } from "../src/images.js";
import { tmpDir } from "./helpers.js";

describe("action log", () => {
  it("stores entries with webp screenshots and thumbnails, newest first, paged", async () => {
    const dir = tmpDir();
    const log = new ActionLog(openDb(":memory:"), path.join(dir, "shots"), pino({ level: "silent" }));
    const png = makePng(1280, 800, [10, 20, 30], [[100, 100]]);
    const ids = [1, 2, 3].map((i) =>
      log.record({ desktopId: "d1", tool: "left_click", args: { coordinate: [i, i] }, summary: `click ${i}`, outcome: "ok", actor: "tok", session: "s", overlays: [{ kind: "point", at: [i, i] }], screenshot: png }),
    );
    await log.flush();
    const page = log.list("d1", { limit: 2 });
    expect(page.map((e) => e.id)).toEqual([ids[2], ids[1]]);
    expect(log.list("d1", { before: ids[1], limit: 10 }).map((e) => e.id)).toEqual([ids[0]]);
    expect(page[0]).toMatchObject({ tool: "left_click", actor: "tok", hasScreenshot: true, overlays: [{ kind: "point", at: [3, 3] }] });
    const full = log.screenshotFile(ids[0]!, false)!;
    const thumb = log.screenshotFile(ids[0]!, true)!;
    expect(full.endsWith(".webp") && !full.endsWith(".thumb.webp")).toBe(true);
    expect(thumb.endsWith(".thumb.webp")).toBe(true);
    expect(fs.readFileSync(full).subarray(8, 12).toString()).toBe("WEBP");
    expect(fs.statSync(thumb).size).toBeLessThan(fs.statSync(full).size + 1);
    expect(log.diskBytes()).toBeGreaterThan(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps full screenshots for the retention period, then thumbnails only; drops removed desktops' rows later", async () => {
    const dir = tmpDir();
    const db = openDb(":memory:");
    const log = new ActionLog(db, path.join(dir, "shots"), pino({ level: "silent" }));
    const png = makePng(320, 200, [1, 2, 3]);
    const day = 86_400_000;
    const now = Date.parse("2026-10-22T00:00:00Z");
    const old = log.record({ desktopId: "d1", tool: "screenshot", summary: "s", outcome: "ok", actor: null, session: null, screenshot: png, at: new Date(now - 8 * day).toISOString() });
    const fresh = log.record({ desktopId: "d1", tool: "screenshot", summary: "s", outcome: "ok", actor: null, session: null, screenshot: png, at: new Date(now - 1 * day).toISOString() });
    const ancient = log.record({ desktopId: "gone", tool: "screenshot", summary: "s", outcome: "ok", actor: null, session: null, screenshot: png, at: new Date(now - 40 * day).toISOString() });
    await log.flush();
    const r = log.prune({ fullMs: 7 * day, thumbMs: 30 * day, removedDesktopIds: () => new Set(["gone"]), now });
    expect(r).toEqual({ prunedFull: 2, deleted: 1 });
    // Old entry falls back to the thumbnail for both full and thumb requests.
    expect(log.screenshotFile(old, false)!.endsWith(".thumb.webp")).toBe(true);
    expect(log.screenshotFile(fresh, false)!.endsWith(".thumb.webp")).toBe(false);
    expect(log.get(ancient)).toBeNull();
    expect(log.get(old)?.hasScreenshot).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("agent screenshots", () => {
  it("are PNG when they fit the budget, otherwise JPEG within it, never resized", async () => {
    const small = makePng(1280, 800, [200, 200, 200]);
    const a = await encodeForAgent(small, { maxBytes: 100_000, jpegQuality: 80, minJpegQuality: 30 });
    expect(a.mime).toBe("image/png");
    // Noise does not compress: forces the JPEG path.
    const sharp = (await import("sharp")).default;
    const noise = await sharp(Buffer.from(Array.from({ length: 1280 * 800 * 3 }, () => Math.floor(Math.random() * 256))), { raw: { width: 1280, height: 800, channels: 3 } })
      .png()
      .toBuffer();
    const b = await encodeForAgent(noise, { maxBytes: 400_000, jpegQuality: 80, minJpegQuality: 30 });
    expect(b.mime).toBe("image/jpeg");
    expect(b.width).toBe(1280);
    expect(b.height).toBe(800);
    expect(b.data.length).toBeLessThanOrEqual(400_000);
  });
});
