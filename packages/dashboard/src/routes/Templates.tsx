import { Link } from "react-router";
import type { TemplateFeedback, TemplateSummary } from "@deskhand/shared";
import { MobileHeader } from "../components/Nav";
import { errorMessage } from "../lib/api";
import { cn } from "../lib/cn";
import { ago, since } from "../lib/format";
import { useNow } from "../lib/now";
import { useTemplates } from "../lib/queries";

export function Markers({ t, className }: { t: TemplateSummary; className?: string }) {
  return (
    <span className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs", className)}>
      {t.isDefault ? <span className="text-dim">default</span> : null}
      {t.recentlyChangedByAgent ? (
        <span className="inline-flex items-center gap-1.5 text-amber" data-testid="marker-agent">
          <span className="h-[5px] w-[5px] rounded-full bg-amber" />
          changed by agent
        </span>
      ) : null}
      {t.stale ? (
        <span className="text-amber/80" title={t.staleReason ?? undefined} data-testid="marker-stale">
          stale{t.staleReason ? ` · ${t.staleReason}` : ""}
        </span>
      ) : null}
      {t.outdatedBase ? (
        <span className="text-red/90" title={t.currentBaseVersion ? `built on ${t.baseVersion ?? "?"}; the manager now runs ${t.currentBaseVersion}` : undefined}>
          outdated base
        </span>
      ) : null}
      {t.rebuild && (t.rebuild.status === "queued" || t.rebuild.status === "running") ? (
        <span className="text-blue" data-testid="marker-rebuild">
          rebuild {t.rebuild.status}…
        </span>
      ) : null}
      {t.rebuild?.status === "failed" ? (
        <span className="text-red" title={t.rebuild.error ?? undefined} data-testid="marker-rebuild">
          rebuild failed
        </span>
      ) : null}
      {t.currentVersion !== t.latestVersion ? (
        <span className="text-violet">
          rolled back · latest v{t.latestVersion}
        </span>
      ) : null}
    </span>
  );
}

export function FeedbackLine({ f, now }: { f: TemplateFeedback; now: number }) {
  return (
    <span className="min-w-0 truncate">
      <span className={f.kind === "ok" ? "text-green" : "text-red"}>{f.kind === "ok" ? "✓ ok" : "✗ problem"}</span>
      <span className="text-muted"> “{f.note}” · {since(f.at, now)}</span>
    </span>
  );
}

export function Templates() {
  const { data, error, isPending } = useTemplates();
  const now = useNow();
  const list = [...(data ?? [])].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || b.updatedAt.localeCompare(a.updatedAt));
  return (
    <div className="pb-24 sm:pb-10">
      <MobileHeader />
      <div className="px-4 sm:px-[18px]">
        <div className="flex items-baseline gap-3 sm:mt-2">
          <h1 className="font-medium text-fg">templates</h1>
          <span className="text-muted">{data ? data.length : ""}</span>
          <span className="ml-auto hidden text-2xs text-faint sm:inline">saved desktops agents start from · every save is a new version</span>
        </div>
        {error ? <p className="mt-6 text-red">{errorMessage(error)}</p> : null}
        {isPending ? <p className="mt-6 text-muted">loading…</p> : null}
        <ul className="mt-3 border-t border-line">
          {list.map((t) => (
            <li key={t.name} className="border-b border-line" data-testid="template-row">
              <Link to={`/templates/${encodeURIComponent(t.name)}`} className="block py-3 hover:bg-panel sm:grid sm:grid-cols-[220px_1fr_260px] sm:gap-6 sm:px-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-fg">{t.name}</span>
                    <span className="text-muted">v{t.currentVersion}</span>
                  </div>
                  <Markers t={t} className="mt-1" />
                </div>
                <div className="mt-1 min-w-0 sm:mt-0">
                  <div className="text-fg">{t.description.summary}</div>
                  <div className="mt-0.5 text-muted">
                    <span className="text-faint">use when </span>
                    {t.description.use_when}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {t.loggedInSites.length ? (
                      t.loggedInSites.map((s) => (
                        <span key={s} className="rounded-sm border border-line-strong px-1.5 text-2xs text-dim">
                          {s}
                        </span>
                      ))
                    ) : (
                      <span className="text-2xs text-faint">no logins</span>
                    )}
                  </div>
                </div>
                <div className="mt-2 min-w-0 text-xs sm:mt-0 sm:text-right">
                  <div className="text-muted">updated {ago(t.updatedAt, now)}</div>
                  {t.lastFeedback ? (
                    <div className="mt-0.5 flex sm:justify-end">
                      <FeedbackLine f={t.lastFeedback} now={now} />
                    </div>
                  ) : (
                    <div className="mt-0.5 text-faint">no feedback yet</div>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
