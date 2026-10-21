import { Link } from "react-router";
import type { DesktopSummary } from "@deskhand/shared";
import { displayState, displayTitle, lockIsLong, statusLine, uptimeLabel } from "../lib/desktop";
import { formatBytes } from "../lib/format";
import { cn } from "../lib/cn";
import { useNow } from "../lib/now";
import { StatusDot } from "./StatusDot";
import { Thumbnail } from "./Thumbnail";

function usageTitle(d: DesktopSummary) {
  const parts = [d.name, d.session, `${d.template}@v${d.templateVersion}`];
  if (d.cpuPercent != null) parts.push(`cpu ${Math.round(d.cpuPercent)}%`);
  if (d.memoryBytes != null) parts.push(`mem ${formatBytes(d.memoryBytes)}`);
  return parts.filter(Boolean).join(" · ");
}

export function frameClass(d: DesktopSummary) {
  const s = displayState(d);
  return s === "attention" ? "border-amber" : s === "control" ? "border-violet" : "border-transparent";
}

/** Grid tile: thumbnail, then `● title  uptime` and a status / last-action line. */
export function DesktopTile({ desktop: d }: { desktop: DesktopSummary }) {
  const now = useNow();
  const state = displayState(d);
  return (
    <Link to={`/desktops/${d.id}`} className="group block min-w-0" data-testid="desktop-tile" data-state={state} title={usageTitle(d)}>
      <div className={cn("aspect-[16/10] overflow-hidden rounded-sm border transition-colors group-hover:border-line-strong", frameClass(d))}>
        <Thumbnail desktop={d} />
      </div>
      <div className="mt-[9px] flex items-center gap-[9px] px-[2px]">
        <StatusDot state={state} pulse={state === "control" && lockIsLong(d, now)} />
        <span className={cn("truncate font-medium", state === "stopped" ? "text-muted" : "text-fg")}>{displayTitle(d)}</span>
        <span className="ml-auto shrink-0 tabular-nums text-muted">{uptimeLabel(d, now)}</span>
      </div>
      <div className="mt-[3px] truncate pl-[17px] text-muted">{statusLine(d, now)}</div>
    </Link>
  );
}

/** Phone list row (mobile prototype). */
export function DesktopRow({ desktop: d }: { desktop: DesktopSummary }) {
  const now = useNow();
  const state = displayState(d);
  return (
    <Link to={`/desktops/${d.id}`} className="flex items-center gap-3 border-b border-line py-[9px] active:bg-raised" data-testid="desktop-row" data-state={state}>
      <div className={cn("h-[58px] w-[88px] shrink-0 overflow-hidden rounded-sm border", frameClass(d))}>
        <Thumbnail desktop={d} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-[9px]">
          <StatusDot state={state} pulse={state === "control" && lockIsLong(d, now)} />
          <span className={cn("truncate font-medium", state === "stopped" ? "text-muted" : "text-fg")}>{displayTitle(d)}</span>
          <span className="ml-auto shrink-0 pl-2 tabular-nums text-muted">{uptimeLabel(d, now)}</span>
        </div>
        <div className="mt-[3px] truncate pl-[15px] text-muted">{statusLine(d, now)}</div>
      </div>
    </Link>
  );
}
