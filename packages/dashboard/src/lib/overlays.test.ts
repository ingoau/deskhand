import { describe, expect, it } from "vitest";
import { arrowHead, clampPt, crosshair, dedupe, overlayBounds, polygonPoints, polylinePoints, regionRect, unitFor } from "./overlays";

describe("overlay geometry", () => {
  it("crosshair centres on the click and scales with the unit", () => {
    const c = crosshair([640, 470], 1);
    expect(c.circle).toEqual({ cx: 640, cy: 470, r: 7 });
    expect(c.lines).toHaveLength(4);
    // ticks sit outside the ring
    for (const [x1, y1, x2, y2] of c.lines) {
      const d1 = Math.hypot(x1 - 640, y1 - 470);
      const d2 = Math.hypot(x2 - 640, y2 - 470);
      expect(Math.min(d1, d2)).toBeGreaterThan(c.circle.r);
    }
    const big = crosshair([640, 470], 4);
    expect(big.circle.r).toBe(28);
  });

  it("unit converts screen px per CSS px", () => {
    expect(unitFor(1280, 320)).toBe(4);
    expect(unitFor(1280, 1280)).toBe(1);
    expect(unitFor(1280, 0)).toBe(1);
  });

  it("polyline drops duplicate points", () => {
    expect(dedupe([[1, 1], [1, 1], [2, 2], [2, 2], [1, 1]])).toEqual([[1, 1], [2, 2], [1, 1]]);
    expect(polylinePoints([[212, 380], [212, 380], [904, 410]])).toBe("212,380 904,410");
  });

  it("arrowhead points along the last segment with its tip at the end", () => {
    const head = arrowHead([[0, 0], [100, 0]], 1)!;
    expect(head[0]).toEqual([100, 0]);
    // base corners are behind the tip and symmetric around the line
    expect(head[1][0]).toBeCloseTo(89);
    expect(head[2][0]).toBeCloseTo(89);
    expect(head[1][1]).toBeCloseTo(5);
    expect(head[2][1]).toBeCloseTo(-5);

    const down = arrowHead([[10, 10], [10, 10], [10, 50]], 2)!;
    expect(down[0]).toEqual([10, 50]);
    expect(down[1][1]).toBeCloseTo(28);
    expect(down[2][1]).toBeCloseTo(28);
    expect(polygonPoints(down)).toBe("10,50 0,28 20,28");
  });

  it("arrowhead is null without direction", () => {
    expect(arrowHead([[5, 5]], 1)).toBeNull();
    expect(arrowHead([[5, 5], [5, 5]], 1)).toBeNull();
  });

  it("region rect normalises corner order", () => {
    expect(regionRect([480, 380, 800, 560])).toEqual({ x: 480, y: 380, width: 320, height: 180 });
    expect(regionRect([800, 560, 480, 380])).toEqual({ x: 480, y: 380, width: 320, height: 180 });
  });

  it("bounds cover every overlay kind", () => {
    expect(
      overlayBounds([
        { kind: "point", at: [640, 470] },
        { kind: "path", points: [[212, 380], [904, 410]] },
        { kind: "region", region: [480, 300, 800, 560] },
      ]),
    ).toEqual({ x: 212, y: 300, width: 692, height: 260 });
    expect(overlayBounds([])).toBeNull();
  });

  it("clamps to the screen", () => {
    expect(clampPt([-4, 900], { width: 1280, height: 800 })).toEqual([0, 800]);
  });
});
