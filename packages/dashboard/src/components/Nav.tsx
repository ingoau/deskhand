import { useState } from "react";
import { Link, NavLink, useLocation } from "react-router";
import { cn } from "../lib/cn";
import { formatBytes } from "../lib/format";
import { useSystem, useTemplates } from "../lib/queries";
import { NewDesktopDialog } from "./NewDesktopDialog";

export function SystemSummaryText({ className }: { className?: string }) {
  const { data: s } = useSystem();
  if (!s) return <span className={cn("text-muted", className)}>&nbsp;</span>;
  return (
    <span className={cn("tabular-nums text-muted", className)} data-testid="system-summary" title={`running/max · cpu · memory (budget ${formatBytes(s.memoryBudgetBytes)})`}>
      {s.running}/{s.maxDesktops} · {Math.round(s.cpuPercent)}% · {formatBytes(s.memoryUsedBytes)}
    </span>
  );
}

function useTemplatesChanged() {
  const { data } = useTemplates();
  return !!data?.some((t) => t.recentlyChangedByAgent);
}

const navClass = ({ isActive }: { isActive: boolean }) => cn("transition-colors", isActive ? "font-medium text-fg" : "text-muted hover:text-fg");

/** Desktop header: `deskhand  desktops  templates·          6/8 · 46% · 9.8G   + new` */
export function TopNav() {
  const changed = useTemplatesChanged();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  return (
    <header className="hidden h-[46px] items-center gap-6 px-[18px] sm:flex">
      <Link to="/" className="font-bold text-fg">
        deskhand
      </Link>
      <nav className="flex items-center gap-[14px]">
        <NavLink to="/" end className={({ isActive }) => navClass({ isActive: isActive || loc.pathname.startsWith("/desktops/") })}>
          desktops
        </NavLink>
        <NavLink to="/templates" className={navClass}>
          templates
          {changed ? <span className="ml-[7px] text-amber" title="changed by an agent in the last 24h" data-testid="templates-changed">·</span> : null}
        </NavLink>
      </nav>
      <div className="ml-auto flex items-center gap-6">
        <SystemSummaryText />
        <NavLink to="/settings" className={navClass}>
          settings
        </NavLink>
        <button className="font-medium text-fg hover:text-amber" onClick={() => setOpen(true)} data-testid="new-desktop">
          + new
        </button>
      </div>
      <NewDesktopDialog open={open} onOpenChange={setOpen} />
    </header>
  );
}

/** Phone header for top-level pages: `deskhand        6/8 · 46% · 9.8G   +` */
export function MobileHeader({ title = "deskhand" }: { title?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <header className="flex h-[52px] items-center gap-3 px-4 sm:hidden">
      <Link to="/" className="text-base font-bold text-fg">
        {title}
      </Link>
      <div className="ml-auto flex items-center gap-4">
        <SystemSummaryText className="text-xs" />
        <Link to="/settings" className="text-muted" aria-label="settings">
          ⚙
        </Link>
        <button className="-mr-2 px-2 text-lg leading-none text-fg" aria-label="new desktop" onClick={() => setOpen(true)}>
          +
        </button>
      </div>
      <NewDesktopDialog open={open} onOpenChange={setOpen} />
    </header>
  );
}

/** Phone bottom tabs: desktops / templates. */
export function BottomTabs() {
  const changed = useTemplatesChanged();
  const tab = ({ isActive }: { isActive: boolean }) =>
    cn("flex-1 py-4 text-center", isActive ? "text-fg underline decoration-1 underline-offset-[5px]" : "text-muted");
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-bg/95 backdrop-blur sm:hidden" style={{ paddingBottom: "max(0px, env(safe-area-inset-bottom))" }}>
      <NavLink to="/" end className={tab}>
        desktops
      </NavLink>
      <NavLink to="/templates" className={tab}>
        templates{changed ? <span className="text-amber">·</span> : null}
      </NavLink>
    </nav>
  );
}
