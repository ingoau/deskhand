import type { DisplayState } from "../lib/desktop";
import { cn } from "../lib/cn";

const COLOR: Record<DisplayState, string> = {
  attention: "bg-amber",
  running: "bg-green",
  control: "bg-violet",
  stopped: "bg-grey",
  starting: "bg-blue animate-pulse-dot",
  error: "bg-red",
  removing: "bg-grey animate-pulse-dot",
};

const LABEL: Record<DisplayState, string> = {
  attention: "needs you",
  running: "running",
  control: "you have control",
  stopped: "stopped",
  starting: "starting",
  error: "error",
  removing: "removing",
};

export function StatusDot({ state, className, pulse }: { state: DisplayState; className?: string; pulse?: boolean }) {
  return (
    <span
      role="img"
      aria-label={LABEL[state]}
      title={LABEL[state]}
      data-state={state}
      className={cn("inline-block h-[6px] w-[6px] shrink-0 rounded-full", COLOR[state], pulse && "animate-pulse-dot", className)}
    />
  );
}

export const stateLabel = (s: DisplayState) => LABEL[s];
