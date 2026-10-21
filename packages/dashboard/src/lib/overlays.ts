/**
 * Geometry for the marks drawn over action-log screenshots. All coordinates are screen pixels (the SVG
 * viewBox is the desktop's screen size); `unit` is how many screen pixels one CSS pixel covers at the
 * current display size, so marks keep a constant on-screen size whether shown as a thumbnail or enlarged.
 */
import type { Overlay } from "@deskhand/shared";

export type Pt = readonly [number, number];

export interface Screen {
  width: number;
  height: number;
}

export function clampPt([x, y]: Pt, s: Screen): [number, number] {
  return [Math.min(Math.max(x, 0), s.width), Math.min(Math.max(y, 0), s.height)];
}

/** Click marker: ring plus crosshair ticks outside it. */
export function crosshair(at: Pt, unit: number) {
  const [x, y] = at;
  const r = 7 * unit;
  const inner = r + 2 * unit;
  const outer = r + 7 * unit;
  return {
    circle: { cx: x, cy: y, r },
    dot: { cx: x, cy: y, r: 1.5 * unit },
    lines: [
      [x - outer, y, x - inner, y],
      [x + inner, y, x + outer, y],
      [x, y - outer, x, y - inner],
      [x, y + inner, x, y + outer],
    ] as [number, number, number, number][],
    label: { x: x + outer + 2 * unit, y: y - inner },
  };
}

/** Drop consecutive duplicate points. */
export function dedupe(points: readonly Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out;
}

export function polylinePoints(points: readonly Pt[]): string {
  return dedupe(points)
    .map(([x, y]) => `${x},${y}`)
    .join(" ");
}

/**
 * Arrowhead triangle at the end of a path, pointing along the last non-zero segment.
 * Returns the three corners (tip first), or null when the path has no direction.
 */
export function arrowHead(points: readonly Pt[], unit: number): [Pt, Pt, Pt] | null {
  const pts = dedupe(points);
  if (pts.length < 2) return null;
  const tip = pts[pts.length - 1]!;
  const from = pts[pts.length - 2]!;
  const dx = tip[0] - from[0];
  const dy = tip[1] - from[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return null;
  const ux = dx / len;
  const uy = dy / len;
  const length = 11 * unit;
  const half = 5 * unit;
  const bx = tip[0] - ux * length;
  const by = tip[1] - uy * length;
  return [tip, [bx - uy * half, by + ux * half], [bx + uy * half, by - ux * half]];
}

export function polygonPoints(pts: readonly Pt[]): string {
  return pts.map(([x, y]) => `${round(x)},${round(y)}`).join(" ");
}

/** Zoom region [x0, y0, x1, y1] (any corner order) to an SVG rect. */
export function regionRect(region: readonly [number, number, number, number]) {
  const [x0, y0, x1, y1] = region;
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
}

/** Bounding box of every overlay, useful for tests and for centring a zoomed view. */
export function overlayBounds(overlays: readonly Overlay[]): { x: number; y: number; width: number; height: number } | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const o of overlays) {
    if (o.kind === "point") {
      xs.push(o.at[0]);
      ys.push(o.at[1]);
    } else if (o.kind === "path") {
      for (const [x, y] of o.points) {
        xs.push(x);
        ys.push(y);
      }
    } else {
      const r = regionRect(o.region);
      xs.push(r.x, r.x + r.width);
      ys.push(r.y, r.y + r.height);
    }
  }
  if (!xs.length) return null;
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Screen pixels per CSS pixel for an image of `screenWidth` rendered `renderedWidth` px wide. */
export function unitFor(screenWidth: number, renderedWidth: number): number {
  return renderedWidth > 0 ? screenWidth / renderedWidth : 1;
}

function round(n: number) {
  return Math.round(n * 10) / 10;
}
