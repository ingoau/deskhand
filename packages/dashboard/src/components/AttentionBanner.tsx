import { Link } from "react-router";
import type { DesktopSummary } from "@deskhand/shared";
import { displayTitle } from "../lib/desktop";
import { since } from "../lib/format";
import { useNow } from "../lib/now";

/** `● supplier-portal-sign-up needs you  “CAPTCHA on the sign-in page” · 2m  take over →` */
export function AttentionBanner({ desktop: d }: { desktop: DesktopSummary }) {
  const now = useNow();
  const a = d.attention!;
  const to = `/desktops/${d.id}`;
  return (
    <>
      {/* desktop: one line */}
      <div className="hidden min-w-0 items-center gap-[9px] sm:flex" data-testid="attention-banner">
        <span className="h-[6px] w-[6px] shrink-0 rounded-full bg-amber" />
        <Link to={to} className="shrink-0 font-medium text-fg hover:underline underline-offset-4">
          {displayTitle(d)} needs you
        </Link>
        <span className="ml-1 truncate text-muted">
          “{a.reason}” · {since(a.since, now)}
        </span>
        <Link to={to} state={{ takeover: true }} className="ml-1 shrink-0 font-medium text-amber hover:underline underline-offset-4">
          take over →
        </Link>
      </div>
      {/* phone: amber card */}
      <div className="rounded-sm border-l-2 border-amber bg-amber-bg px-3 py-2.5 sm:hidden" data-testid="attention-card">
        <div className="flex items-center gap-2">
          <span className="h-[6px] w-[6px] shrink-0 rounded-full bg-amber" />
          <span className="truncate text-fg">{displayTitle(d)} needs you</span>
        </div>
        <div className="mt-1 text-dim">
          “{a.reason}” · {since(a.since, now)}
        </div>
        <Link to={to} state={{ takeover: true }} className="mt-1 inline-block py-1 font-medium text-amber">
          take over →
        </Link>
      </div>
    </>
  );
}
