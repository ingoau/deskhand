import sharp from "sharp";

export interface AgentImageOptions {
  /** Byte budget for one image (before base64). */
  maxBytes: number;
  /** First JPEG quality to try when PNG is over budget. */
  jpegQuality: number;
  minJpegQuality: number;
}

export interface EncodedImage {
  mime: "image/png" | "image/jpeg";
  data: Buffer;
  width: number;
  height: number;
}

function isPng(b: Buffer) {
  return b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
}
function isJpeg(b: Buffer) {
  return b.length > 3 && b[0] === 0xff && b[1] === 0xd8;
}

/**
 * Agent-facing screenshots are PNG or JPEG (computer_toolset_20260801 names those; no WebP).
 * PNG when it fits the byte budget, otherwise JPEG at decreasing quality. Never resized, so
 * screenshot pixels stay equal to screen pixels.
 */
export async function encodeForAgent(input: Buffer, opts: AgentImageOptions): Promise<EncodedImage> {
  const img = sharp(input);
  const meta = await img.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (isPng(input) && input.length <= opts.maxBytes) return { mime: "image/png", data: input, width, height };
  if (isJpeg(input) && input.length <= opts.maxBytes) return { mime: "image/jpeg", data: input, width, height };
  // Flatten alpha: JPEG has none.
  const base = sharp(input).flatten({ background: "#ffffff" });
  let best: Buffer | undefined;
  for (let q = opts.jpegQuality; q >= opts.minJpegQuality; q -= 10) {
    const out = await base.clone().jpeg({ quality: q, mozjpeg: true }).toBuffer();
    best = out;
    if (out.length <= opts.maxBytes) break;
  }
  if (best && best.length > opts.maxBytes) {
    // Last resort: lower chroma resolution at the minimum quality (still full pixel size).
    const out = await base.clone().jpeg({ quality: opts.minJpegQuality, mozjpeg: true, chromaSubsampling: "4:2:0" }).toBuffer();
    if (out.length < best.length) best = out;
  }
  return { mime: "image/jpeg", data: best!, width, height };
}

/** Full-size WebP + thumbnail for the action log. */
export async function encodeForLog(input: Buffer, thumbWidth = 320): Promise<{ full: Buffer; thumb: Buffer }> {
  const full = await sharp(input).webp({ quality: 75 }).toBuffer();
  const thumb = await sharp(input).resize({ width: thumbWidth, withoutEnlargement: true }).webp({ quality: 60 }).toBuffer();
  return { full, thumb };
}

/** Scaled WebP for dashboard tiles. Passes WebP through when it is already small enough. */
export async function toThumbnail(input: Buffer, mime: string, width: number): Promise<Buffer> {
  const meta = await sharp(input).metadata();
  if (mime === "image/webp" && (meta.width ?? 0) <= width) return input;
  return sharp(input).resize({ width, withoutEnlargement: true }).webp({ quality: 60 }).toBuffer();
}

export async function toPng(input: Buffer): Promise<Buffer> {
  if (isPng(input)) return input;
  return sharp(input).png().toBuffer();
}
