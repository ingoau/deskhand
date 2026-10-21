/**
 * Drag planning (pure). Implements the plan's "Input fidelity" drag sequence:
 * hover pause → press → ~5 px nudge → 15–25 eased steps over duration_ms → hold on target → release.
 */
export type Point = [number, number];

export const DRAG_DEFAULTS = {
  durationMs: 400,
  holdMs: 150,
  hoverMs: 50,
  nudgePx: 5,
  /** Pause after the press, before the nudge, so the app sees a distinct press. */
  pressMs: 40,
  minSteps: 15,
  maxSteps: 25,
} as const;

/** Smooth start and stop (cubic ease-in-out), t in [0,1]. */
export function easeInOutCubic(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
}

/** Number of steps for a drag of this length: 15 for short drags up to 25 for long ones. */
export function stepCount(distance: number, minSteps: number = DRAG_DEFAULTS.minSteps, maxSteps: number = DRAG_DEFAULTS.maxSteps): number {
  return Math.max(minSteps, Math.min(maxSteps, Math.round(distance / 25)));
}

export interface DragPlan {
  start: Point;
  end: Point;
  hoverMs: number;
  pressMs: number;
  /** First move after the press, ~5 px toward the target, to pass drag thresholds. */
  nudge: Point;
  /** Eased points from the nudge to the end; the last point is exactly `end`. */
  steps: Point[];
  stepDelayMs: number;
  holdMs: number;
}

export function planDrag(start: Point, end: Point, opts: { durationMs?: number; holdMs?: number } = {}): DragPlan {
  const durationMs = opts.durationMs ?? DRAG_DEFAULTS.durationMs;
  const holdMs = opts.holdMs ?? DRAG_DEFAULTS.holdMs;
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const dist = Math.hypot(dx, dy);
  // Nudge toward the target (or right, for a zero-length drag), never past it.
  const n = Math.min(DRAG_DEFAULTS.nudgePx, dist > 0 ? dist : DRAG_DEFAULTS.nudgePx);
  const ux = dist > 0 ? dx / dist : 1;
  const uy = dist > 0 ? dy / dist : 0;
  const nudge: Point = [Math.round(start[0] + ux * n), Math.round(start[1] + uy * n)];
  const count = stepCount(dist);
  const steps: Point[] = [];
  for (let i = 1; i <= count; i++) {
    const e = easeInOutCubic(i / count);
    steps.push([Math.round(nudge[0] + (end[0] - nudge[0]) * e), Math.round(nudge[1] + (end[1] - nudge[1]) * e)]);
  }
  steps[steps.length - 1] = [end[0], end[1]];
  return {
    start,
    end,
    hoverMs: DRAG_DEFAULTS.hoverMs,
    pressMs: DRAG_DEFAULTS.pressMs,
    nudge,
    steps,
    stepDelayMs: count > 0 ? durationMs / count : 0,
    holdMs,
  };
}

/** Intermediate points for a plain move while a button is held (canvas strokes, manual drags). */
export function heldMovePath(from: Point, to: Point, maxStepPx = 12): Point[] {
  const dist = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const count = Math.max(1, Math.min(40, Math.ceil(dist / maxStepPx)));
  const pts: Point[] = [];
  for (let i = 1; i <= count; i++) {
    const t = i / count;
    pts.push([Math.round(from[0] + (to[0] - from[0]) * t), Math.round(from[1] + (to[1] - from[1]) * t)]);
  }
  return pts;
}

/** Total time a drag takes (for deadlines). */
export function dragDurationMs(plan: DragPlan): number {
  return plan.hoverMs + plan.pressMs + plan.stepDelayMs * plan.steps.length + plan.holdMs;
}
