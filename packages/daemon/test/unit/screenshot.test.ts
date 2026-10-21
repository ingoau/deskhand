import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { bgrxToRgb, encodeFrame, parseRegion, zoomSize } from "../../src/screenshot.js";

/** A 64x40 BGRX frame where pixel (x,y) = (r=x*4, g=y*4, b=200). */
function frame(w = 64, h = 40) {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = 200; // B
      data[i + 1] = y * 4; // G
      data[i + 2] = x * 4; // R
    }
  return { data, width: w, height: h };
}

describe("parseRegion", () => {
  it("accepts x0,y0,x1,y1 and [x0,y0,x1,y1]", () => {
    expect(parseRegion("0,0,10,20", 64, 40)).toEqual([0, 0, 10, 20]);
    expect(parseRegion("[1, 2, 3, 4]", 64, 40)).toEqual([1, 2, 3, 4]);
    expect(parseRegion(undefined, 64, 40)).toBeUndefined();
  });
  it("rejects malformed or out-of-screen regions", () => {
    expect(() => parseRegion("1,2,3", 64, 40)).toThrow(/four integers/);
    expect(() => parseRegion("10,10,5,20", 64, 40)).toThrow(/must satisfy/);
    expect(() => parseRegion("0,0,65,40", 64, 40)).toThrow(/must satisfy/);
    expect(() => parseRegion("-1,0,10,10", 64, 40)).toThrow(/must satisfy/);
  });
});

describe("zoomSize", () => {
  it("scales a region to fit within the screen, keeping the aspect ratio", () => {
    expect(zoomSize(320, 200, 1280, 800)).toEqual([1280, 800]);
    expect(zoomSize(100, 400, 1280, 800)).toEqual([200, 800]);
    expect(zoomSize(1280, 100, 1280, 800)).toEqual([1280, 100]);
    expect(zoomSize(640, 400, 1280, 800)).toEqual([1280, 800]);
  });
});

describe("bgrxToRgb", () => {
  it("swaps channels and crops", () => {
    const f = frame();
    const r = bgrxToRgb(f, [10, 5, 12, 7]);
    expect(r.width).toBe(2);
    expect(r.height).toBe(2);
    expect([...r.data.subarray(0, 3)]).toEqual([40, 20, 200]);
    expect([...r.data.subarray(3, 6)]).toEqual([44, 20, 200]);
  });
});

describe("encodeFrame", () => {
  it("encodes full-frame PNG with exact pixels", async () => {
    const e = await encodeFrame(frame(), { format: "png" });
    expect(e.mime).toBe("image/png");
    expect([e.width, e.height]).toEqual([64, 40]);
    const { data, info } = await sharp(e.data).raw().toBuffer({ resolveWithObject: true });
    const i = (7 * 64 + 9) * info.channels;
    expect([data[i], data[i + 1], data[i + 2]]).toEqual([36, 28, 200]);
  });
  it("zooms a region to the screen size", async () => {
    const e = await encodeFrame(frame(), { format: "png", region: [0, 0, 16, 10] });
    expect([e.width, e.height]).toEqual([64, 40]);
    const meta = await sharp(e.data).metadata();
    expect([meta.width, meta.height]).toEqual([64, 40]);
  });
  it("scales thumbnails and supports jpeg/webp", async () => {
    const j = await encodeFrame(frame(), { format: "jpeg", quality: 50, scale: 0.5 });
    expect(j.mime).toBe("image/jpeg");
    expect([j.width, j.height]).toEqual([32, 20]);
    const w = await encodeFrame(frame(), { format: "webp", scale: 0.25 });
    expect(w.mime).toBe("image/webp");
    expect((await sharp(w.data).metadata()).width).toBe(16);
  });
});
