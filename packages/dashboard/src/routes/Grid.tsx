import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { AttentionBanner } from "../components/AttentionBanner";
import { DesktopRow, DesktopTile } from "../components/DesktopCard";
import { MobileHeader } from "../components/Nav";
import { errorMessage } from "../lib/api";
import { cn } from "../lib/cn";
import { attentionList, FILTER_TABS, filterDesktops, tabCounts, type FilterTab } from "../lib/desktop";
import { useMediaQuery } from "../lib/now";
import { useDesktops } from "../lib/queries";

export function Grid() {
  const { data: desktops, error, isPending } = useDesktops();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<FilterTab>(() => ((FILTER_TABS as string[]).includes(params.get("tab") ?? "") ? (params.get("tab") as FilterTab) : "all"));
  const [query, setQuery] = useState(() => params.get("q") ?? "");
  useEffect(() => {
    // Keep other params (e.g. ?login=expired, handled by the shell).
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        if (tab !== "all") n.set("tab", tab);
        else n.delete("tab");
        if (query) n.set("q", query);
        else n.delete("q");
        return n.toString() === prev.toString() ? prev : n;
      },
      { replace: true },
    );
  }, [tab, query, setParams]);

  const list = desktops ?? [];
  const counts = useMemo(() => tabCounts(list, query), [list, query]);
  const shown = useMemo(() => filterDesktops(list, tab, query), [list, tab, query]);
  const attention = useMemo(() => attentionList(list), [list]);
  const wide = useMediaQuery();

  return (
    <div className="pb-24 sm:pb-10">
      <MobileHeader />
      <div className="px-4 sm:px-[18px]">
        <div className="flex flex-col gap-3 sm:mt-2 sm:flex-row sm:items-center sm:gap-[18px]">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="filter…"
            aria-label="filter desktops"
            className="h-[34px] w-full border-b border-line bg-transparent text-base text-fg placeholder:text-muted focus:border-line-strong focus:outline-none sm:h-[30px] sm:w-[215px] sm:text-sm"
          />
          <div className="flex gap-[14px] sm:gap-[13px]" role="tablist" aria-label="status filter">
            {FILTER_TABS.map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                data-testid={`tab-${t}`}
                onClick={() => setTab(t)}
                className={cn("whitespace-nowrap py-1", tab === t ? "font-medium text-fg underline decoration-1 underline-offset-[5px]" : "text-muted hover:text-dim")}
              >
                {t} {counts[t]}
              </button>
            ))}
          </div>
        </div>

        {attention.length ? (
          <div className="mt-4 flex flex-col gap-2 sm:mt-[18px] sm:gap-1.5">
            {attention.map((d) => (
              <AttentionBanner key={d.id} desktop={d} />
            ))}
          </div>
        ) : null}

        {error && !desktops ? <p className="mt-6 text-red">couldn't load desktops: {errorMessage(error)}</p> : null}
        {isPending ? <p className="mt-6 text-muted">loading…</p> : null}
        {desktops && !shown.length ? (
          <p className="mt-8 text-muted">{list.length ? "nothing matches." : "no desktops yet. agents start them with desktop_start, or use + new."}</p>
        ) : null}

        {wide ? (
          <div className="mt-[14px] grid grid-cols-[repeat(auto-fill,minmax(212px,1fr))] gap-x-[13px] gap-y-[21px]" data-testid="desktop-grid">
            {shown.map((d) => (
              <DesktopTile key={d.id} desktop={d} />
            ))}
          </div>
        ) : (
          <div className="mt-2" data-testid="desktop-list">
            {shown.map((d) => (
              <DesktopRow key={d.id} desktop={d} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
