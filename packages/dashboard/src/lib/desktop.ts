import type { DesktopSummary, TemplateHardware } from "@deskhand/shared";
import { formatUptime, toMs } from "./format";

/** What the dashboard shows for a desktop; drives the status dot colour and tile border. */
export type DisplayState = "attention" | "control" | "running" | "starting" | "stopped" | "error" | "removing";

export function displayState(d: DesktopSummary): DisplayState {
  if (d.status === "removing") return "removing";
  if (d.status === "error") return "error";
  if (d.status === "stopped") return "stopped";
  if (d.status === "starting") return "starting";
  if (d.lock) return "control";
  if (d.attention) return "attention";
  return "running";
}

export function displayTitle(d: Pick<DesktopSummary, "title">): string {
  return d.title?.trim() || "untitled";
}

/** Right-hand time on a tile: time since start; how long it ran when stopped; m:ss while starting. */
export function uptimeLabel(d: DesktopSummary, now: number): string {
  const created = toMs(d.createdAt) ?? now;
  const started = toMs(d.startedAt);
  switch (d.status) {
    case "starting":
      return formatUptime(now - created);
    case "stopped": {
      const stopped = toMs(d.stoppedAt) ?? now;
      return formatUptime(stopped - (started ?? created));
    }
    default:
      return formatUptime(now - (started ?? created));
  }
}

/** Second line on a tile / list row. */
export function statusLine(d: DesktopSummary, now: number): string {
  switch (displayState(d)) {
    case "starting":
      return `${d.template}@v${d.templateVersion}`;
    case "attention":
      return "waiting on you";
    case "control": {
      const since = toMs(d.lock?.since) ?? now;
      return `you have control · ${formatUptime(now - since)}`;
    }
    case "stopped": {
      const stopped = toMs(d.stoppedAt);
      const active = toMs(d.lastActivityAt);
      return stopped != null && active != null && stopped >= active
        ? `stopped · idle ${formatUptime(stopped - active)}`
        : "stopped";
    }
    case "error":
      return "error · see log";
    case "removing":
      return "removing…";
    case "running":
      return d.lastAction?.summary ?? "idle";
  }
}

/** True when the control lock has been held long enough to warn (plan: ~30 min). */
export const LONG_LOCK_MS = 30 * 60 * 1000;
export function lockIsLong(d: DesktopSummary, now: number): boolean {
  const since = toMs(d.lock?.since);
  return since != null && now - since >= LONG_LOCK_MS;
}

export type FilterTab = "all" | "attention" | "running" | "stopped";
export const FILTER_TABS: FilterTab[] = ["all", "attention", "running", "stopped"];

/** Which tab(s) a desktop belongs to. "attention" = needs you or you are in control. */
export function inTab(d: DesktopSummary, tab: FilterTab): boolean {
  const s = displayState(d);
  switch (tab) {
    case "all":
      return true;
    case "attention":
      return s === "attention" || s === "control";
    case "running":
      return s === "running";
    case "stopped":
      return s === "stopped" || s === "error";
  }
}

export function matchesQuery(d: DesktopSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [d.title, d.name, d.id, d.session, `${d.template}@v${d.templateVersion}`, d.lastAction?.summary, d.attention?.reason]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return q.split(/\s+/).every((part) => hay.includes(part));
}

export function tabCounts(desktops: DesktopSummary[], query = ""): Record<FilterTab, number> {
  const base = desktops.filter((d) => matchesQuery(d, query));
  return Object.fromEntries(FILTER_TABS.map((t) => [t, base.filter((d) => inTab(d, t)).length])) as Record<FilterTab, number>;
}

const GROUP: Record<DisplayState, number> = { attention: 0, control: 1, running: 1, error: 2, stopped: 2, removing: 2, starting: 3 };

/** Needs-you first, then active desktops by age, then stopped, then those still starting. */
export function sortDesktops(desktops: DesktopSummary[]): DesktopSummary[] {
  return [...desktops].sort((a, b) => {
    const g = GROUP[displayState(a)] - GROUP[displayState(b)];
    if (g) return g;
    return (toMs(a.createdAt) ?? 0) - (toMs(b.createdAt) ?? 0) || a.id.localeCompare(b.id);
  });
}

export function filterDesktops(desktops: DesktopSummary[], tab: FilterTab, query: string): DesktopSummary[] {
  return sortDesktops(desktops.filter((d) => inTab(d, tab) && matchesQuery(d, query)));
}

/** Desktops with an open request_human, oldest first, excluding ones you already control. */
export function attentionList(desktops: DesktopSummary[]): DesktopSummary[] {
  return desktops
    .filter((d) => d.attention && !d.lock && d.status !== "stopped")
    .sort((a, b) => (toMs(a.attention!.since) ?? 0) - (toMs(b.attention!.since) ?? 0));
}

/** Short memory size as agents and the CLI write it: 8589934592 -> "8g", 1610612736 -> "1536m". */
export function memLabel(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return Number.isInteger(gb) ? `${gb}g` : `${Math.round(bytes / 1024 ** 2)}m`;
}

/** Fallback when /api/system has not loaded yet (DESKHAND_DESKTOP_MEMORY default). */
export const DEFAULT_DESKTOP_MEMORY = 2 * 1024 ** 3;

/** Small hardware markers for tiles and the meta line: `kvm` and the memory cap when it isn't the default. */
export function hardwareMarks(d: Pick<DesktopSummary, "hardware">, defaultMemoryBytes = DEFAULT_DESKTOP_MEMORY): string[] {
  const hw = d.hardware;
  if (!hw) return [];
  const marks: string[] = [];
  if (hw.kvm) marks.push("kvm");
  if (hw.memoryBytes !== defaultMemoryBytes) marks.push(memLabel(hw.memoryBytes));
  return marks;
}

/** A template's recorded hardware: `kvm · 8g · 4 cpu` ("" when it records none). */
export function templateHardwareLabel(hw: TemplateHardware | null | undefined): string {
  if (!hw) return "";
  return [hw.kvm ? "kvm" : "", hw.memoryBytes ? memLabel(hw.memoryBytes) : "", hw.cpus ? `${hw.cpus} cpu` : ""].filter(Boolean).join(" · ");
}

/** `base@v1 · kvm · 8g · t3/onboarding-vendors · 18m` (hardware markers only when non-default). */
export function metaLine(d: DesktopSummary, now: number, defaultMemoryBytes?: number): string {
  return [`${d.template}@v${d.templateVersion}`, ...hardwareMarks(d, defaultMemoryBytes), d.session, uptimeLabel(d, now)].filter(Boolean).join(" · ");
}
