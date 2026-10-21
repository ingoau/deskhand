import { describe, expect, it } from "vitest";
import { DRAG_DEFAULTS, dragDurationMs, easeInOutCubic, heldMovePath, planDrag, stepCount } from "../../src/drag.js";

describe("easeInOutCubic", () => {
  it("starts at 0, ends at 1, passes 0.5 at the midpoint and is monotonic", () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5);
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const v = easeInOutCubic(i / 100);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
  it("is slow at the ends and fast in the middle", () => {
    const startStep = easeInOutCubic(0.1) - easeInOutCubic(0);
    const midStep = easeInOutCubic(0.55) - easeInOutCubic(0.45);
    expect(midStep).toBeGreaterThan(startStep * 3);
  });
});

describe("stepCount", () => {
  it("is between 15 and 25", () => {
    expect(stepCount(0)).toBe(15);
    expect(stepCount(10)).toBe(15);
    expect(stepCount(500)).toBe(20);
    expect(stepCount(5000)).toBe(25);
  });
});

describe("planDrag", () => {
  it("follows the plan's sequence: hover, nudge ~5px toward the target, eased steps ending exactly on target", () => {
    const p = planDrag([100, 100], [400, 100]);
    expect(p.hoverMs).toBe(DRAG_DEFAULTS.hoverMs);
    expect(p.nudge).toEqual([105, 100]);
    expect(p.steps.length).toBeGreaterThanOrEqual(15);
    expect(p.steps.length).toBeLessThanOrEqual(25);
    expect(p.steps.at(-1)).toEqual([400, 100]);
    // monotonic along x
    let x = p.nudge[0];
    for (const [sx] of p.steps) {
      expect(sx).toBeGreaterThanOrEqual(x);
      x = sx;
    }
  });
  it("spreads duration_ms over the steps and uses hold_ms", () => {
    const p = planDrag([0, 0], [300, 400], { durationMs: 1000, holdMs: 300 });
    expect(p.stepDelayMs * p.steps.length).toBeCloseTo(1000);
    expect(p.holdMs).toBe(300);
    expect(dragDurationMs(p)).toBeCloseTo(DRAG_DEFAULTS.hoverMs + DRAG_DEFAULTS.pressMs + 1000 + 300);
  });
  it("defaults to 400 ms and 150 ms", () => {
    const p = planDrag([0, 0], [100, 0]);
    expect(p.stepDelayMs * p.steps.length).toBeCloseTo(400);
    expect(p.holdMs).toBe(150);
  });
  it("nudges diagonally toward the target and never past a short target", () => {
    const p = planDrag([100, 100], [130, 140]);
    expect(p.nudge).toEqual([103, 104]);
    const short = planDrag([100, 100], [102, 100]);
    expect(short.nudge).toEqual([102, 100]);
  });
  it("handles a zero-length drag", () => {
    const p = planDrag([50, 50], [50, 50]);
    expect(p.nudge).toEqual([55, 50]);
    expect(p.steps.at(-1)).toEqual([50, 50]);
  });
});

describe("heldMovePath", () => {
  it("interpolates in small steps and ends on the target", () => {
    const pts = heldMovePath([0, 0], [100, 0]);
    expect(pts.length).toBeGreaterThanOrEqual(8);
    expect(pts.at(-1)).toEqual([100, 0]);
    for (let i = 1; i < pts.length; i++) expect(pts[i]![0] - pts[i - 1]![0]).toBeLessThanOrEqual(13);
  });
  it("returns the target for a zero move", () => {
    expect(heldMovePath([5, 5], [5, 5])).toEqual([[5, 5]]);
  });
});
