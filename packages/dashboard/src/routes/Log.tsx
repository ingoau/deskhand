import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import type { LogEntry } from "@deskhand/shared";
import { ShotWithOverlays } from "../components/ShotWithOverlays";
import { StatusDot } from "../components/StatusDot";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent } from "../components/ui/dialog";
import { api, errorMessage } from "../lib/api";
import { cn } from "../lib/cn";
import { displayState, displayTitle } from "../lib/desktop";
import { clock, dateTime, formatDuration } from "../lib/format";
import { useDesktop, useLog } from "../lib/queries";

const DEFAULT_SCREEN = { width: 1280, height: 800 };

export function LogPage() {
  const { id = "" } = useParams();
  const { data: d } = useDesktop(id);
  const log = useLog(id);
  const [open, setOpen] = useState<LogEntry | null>(null);
  // Pages can overlap after a refetch when new entries arrive; keep the first copy of each id.
  const entries = useMemo(() => {
    const seen = new Set<number>();
    return (log.data?.pages.flat() ?? []).filter((e) => !seen.has(e.id) && (seen.add(e.id), true));
  }, [log.data]);
  const screen = d?.screen ?? DEFAULT_SCREEN;

  // Group by local day.
  const groups = useMemo(() => {
    const out: { day: string; items: LogEntry[] }[] = [];
    for (const e of entries) {
      const day = dateTime(e.at).slice(0, 10);
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(e);
      else out.push({ day, items: [e] });
    }
    return out;
  }, [entries]);

  return (
    <div className="pb-24 sm:pb-10">
      <div className="flex h-[46px] items-center px-4 sm:px-[18px]">
        <Link to={`/desktops/${id}`} className="text-muted hover:text-fg">
          ‹ {d ? displayTitle(d) : "desktop"}
        </Link>
      </div>
      <div className="px-4 sm:px-[18px]">
        <h1 className="flex items-center gap-[10px] text-lg font-bold text-fg">
          {d ? <StatusDot state={displayState(d)} className="h-[7px] w-[7px]" /> : null}
          action log
        </h1>
        <p className="mt-1 pl-[17px] text-muted">
          <span className="hidden sm:inline">every tool call with its result and screenshot · </span>newest first · screenshots kept ~7 days
        </p>

        {log.error ? <p className="mt-6 text-red">{errorMessage(log.error)}</p> : null}
        {log.isPending ? <p className="mt-6 text-muted">loading…</p> : null}
        {!log.isPending && !entries.length ? <p className="mt-6 text-muted">no actions yet.</p> : null}

        <div className="mt-4 max-w-[1100px]">
          {groups.map((g) => (
            <section key={g.day}>
              <div className="sticky top-0 z-10 border-b border-line bg-bg/95 py-1.5 text-2xs text-faint backdrop-blur">{g.day}</div>
              <ol>
                {g.items.map((e) => (
                  <LogRow key={e.id} entry={e} screen={screen} onOpen={() => setOpen(e)} />
                ))}
              </ol>
            </section>
          ))}
        </div>
        {log.hasNextPage ? (
          <div className="mt-4">
            <Button onClick={() => log.fetchNextPage()} disabled={log.isFetchingNextPage}>
              {log.isFetchingNextPage ? "loading…" : "load older"}
            </Button>
          </div>
        ) : null}
      </div>

      <Dialog open={!!open} onOpenChange={(v) => !v && setOpen(null)}>
        {open ? (
          <DialogContent wide title={`${clock(open.at)} · ${open.summary}`}>
            {open.hasScreenshot ? (
              <ShotWithOverlays
                src={api.screenshotUrl(open.id)}
                overlays={open.overlays}
                screen={screen}
                className="mx-auto max-w-[calc((92dvh_-_190px)_*_1.6)] rounded-sm border border-line"
                alt={open.summary}
              />
            ) : (
              <p className="text-muted">no screenshot stored for this call.</p>
            )}
            <EntryMeta entry={open} />
            <pre className="mt-3 max-h-48 overflow-auto rounded-sm border border-line bg-bg p-2 text-2xs text-dim">{JSON.stringify(open.args, null, 2)}</pre>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}

function OutcomeBadge({ outcome }: { outcome: LogEntry["outcome"] }) {
  if (outcome === "ok") return <span className="text-green">ok</span>;
  return <span className={outcome === "error" ? "text-red" : "text-amber"}>{outcome}</span>;
}

function EntryMeta({ entry: e }: { entry: LogEntry }) {
  return (
    <div className="mt-2 text-xs text-muted">
      <OutcomeBadge outcome={e.outcome} />
      {e.durationMs != null ? ` · ${formatDuration(e.durationMs)}` : ""}
      {e.actor ? ` · ${e.actor}` : ""}
      {e.session && e.session !== e.actor ? ` · ${e.session}` : ""}
      {e.error ? (
        <div className="mt-1 text-red">
          {e.error.code}: {e.error.message}
        </div>
      ) : null}
    </div>
  );
}

/** `claude-laptop/9f2c` rather than `claude-laptop · claude-laptop/9f2c`. */
function who(e: LogEntry): string | null {
  if (e.session && e.actor && e.session.startsWith(e.actor + "/")) return e.session;
  return [e.actor, e.session && e.session !== e.actor ? e.session : null].filter(Boolean).join(" · ") || null;
}

function LogRow({ entry: e, screen, onOpen }: { entry: LogEntry; screen: { width: number; height: number }; onOpen: () => void }) {
  const human = e.actor === "dashboard";
  return (
    <li className="grid grid-cols-[1fr_112px] gap-3 border-b border-line py-2.5 sm:grid-cols-[64px_1fr_160px] sm:gap-4" data-testid="log-entry" data-tool={e.tool}>
      <div className="hidden tabular-nums text-muted sm:block">{clock(e.at)}</div>
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span className={cn("min-w-0 break-words", human ? "text-violet" : "text-fg")}>{e.summary}</span>
          {e.outcome !== "ok" ? <OutcomeBadge outcome={e.outcome} /> : null}
        </div>
        <div className="mt-0.5 text-xs text-muted sm:text-[length:inherit]">
          <span className="tabular-nums sm:hidden">{clock(e.at)} · </span>
          {[e.tool, who(e), e.durationMs != null ? formatDuration(e.durationMs) : null].filter(Boolean).join(" · ")}
        </div>
        {e.error ? (
          <div className="mt-1 text-xs text-red">
            {e.error.code} · {e.error.message}
          </div>
        ) : null}
      </div>
      <div>
        {e.hasScreenshot ? (
          <button onClick={onOpen} className="block w-full overflow-hidden rounded-sm border border-line hover:border-line-strong" aria-label={`enlarge screenshot for ${e.summary}`} data-testid="log-shot">
            <ShotWithOverlays src={api.screenshotUrl(e.id, true)} overlays={e.overlays} screen={screen} />
          </button>
        ) : (
          <button onClick={onOpen} className="grid aspect-[16/10] w-full place-items-center rounded-sm border border-dashed border-line text-2xs text-faint hover:text-muted">
            no screenshot
          </button>
        )}
      </div>
    </li>
  );
}
