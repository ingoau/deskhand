/**
 * Screenshot encoding with sharp: PNG (default, exact pixels), JPEG or WebP; optional scale
 * (thumbnails) and zoom region (captured at full resolution, then scaled to fit the screen size
 * with aspect ratio preserved — computer_toolset_20260801's `zoom`).
 */
import sharp from "sharp";
import { DeskhandError, type ImageFormat } from "@deskhand/shared";
import type { Frame } from "./xconn.js";

export interface EncodeOptions {
  format?: ImageFormat;
  quality?: number;
  scale?: number;
  region?: [number, number, number, number];
}

export interface Encoded {
  data: Buffer;
  mime: string;
  width: number;
  height: number;
}

const MIME: Record<ImageFormat, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };

/** Parse "x0,y0,x1,y1" or "[x0,y0,x1,y1]". */
export function parseRegion(s: string | undefined, width: number, height: number): [number, number, number, number] | undefined {
  if (s === undefined || s === "") return undefined;
  const nums = s
    .replace(/[[\]\s]/g, "")
    .split(",")
    .map((v) => Number(v));
  if (nums.length !== 4 || nums.some((n) => !Number.isInteger(n))) {
    throw new DeskhandError("invalid_argument", `region must be four integers "x0,y0,x1,y1"; got "${s}".`);
  }
  return checkRegion(nums as [number, number, number, number], width, height);
}

export function checkRegion(r: [number, number, number, number], width: number, height: number): [number, number, number, number] {
  const [x0, y0, x1, y1] = r;
  if (x0 < 0 || y0 < 0 || x1 > width || y1 > height || x1 <= x0 || y1 <= y0) {
    throw new DeskhandError(
      "invalid_argument",
      `region [${x0}, ${y0}, ${x1}, ${y1}] must satisfy 0 <= x0 < x1 <= ${width} and 0 <= y0 < y1 <= ${height}.`,
    );
  }
  return r;
}

/** Output size for a zoom: the region scaled to fit within the screen, aspect preserved. */
export function zoomSize(regionW: number, regionH: number, screenW: number, screenH: number): [number, number] {
  const f = Math.min(screenW / regionW, screenH / regionH);
  return [Math.max(1, Math.round(regionW * f)), Math.max(1, Math.round(regionH * f))];
}

/** BGRX (4 bytes/pixel) → RGB (3 bytes/pixel), optionally cropping. */
export function bgrxToRgb(frame: Frame, crop?: [number, number, number, number]): { data: Buffer; width: number; height: number } {
  const [x0, y0, x1, y1] = crop ?? [0, 0, frame.width, frame.height];
  const w = x1 - x0;
  const h = y1 - y0;
  const src = frame.data;
  const out = Buffer.allocUnsafe(w * h * 3);
  let o = 0;
  for (let y = y0; y < y1; y++) {
    let i = (y * frame.width + x0) * 4;
    for (let x = 0; x < w; x++, i += 4) {
      out[o++] = src[i + 2]!;
      out[o++] = src[i + 1]!;
      out[o++] = src[i]!;
    }
  }
  return { data: out, width: w, height: h };
}

export async function encodeFrame(frame: Frame, opts: EncodeOptions = {}): Promise<Encoded> {
  const format = opts.format ?? "png";
  const rgb = bgrxToRgb(frame, opts.region);
  let outW = rgb.width;
  let outH = rgb.height;
  if (opts.region) [outW, outH] = zoomSize(rgb.width, rgb.height, frame.width, frame.height);
  if (opts.scale !== undefined && opts.scale !== 1) {
    outW = Math.max(1, Math.round(outW * opts.scale));
    outH = Math.max(1, Math.round(outH * opts.scale));
  }
  let img = sharp(rgb.data, { raw: { width: rgb.width, height: rgb.height, channels: 3 } });
  if (outW !== rgb.width || outH !== rgb.height) {
    img = img.resize(outW, outH, { fit: "fill", kernel: "lanczos3" });
  }
  const q = opts.quality;
  if (format === "png") img = img.png({ compressionLevel: 6, adaptiveFiltering: true });
  else if (format === "jpeg") img = img.jpeg({ quality: q ?? 80, mozjpeg: false });
  else img = img.webp({ quality: q ?? 75, effort: 2 });
  const data = await img.toBuffer();
  return { data, mime: MIME[format], width: outW, height: outH };
}
