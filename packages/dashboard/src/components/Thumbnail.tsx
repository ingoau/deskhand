import { useEffect, useRef, useState } from "react";
import type { DesktopSummary } from "@deskhand/shared";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { usePageVisible } from "../lib/now";

/** Thumbnail refresh interval while visible (plan: every 1–2 s). */
export const THUMB_REFRESH_MS = 1500;

function useInView<T extends Element>(ref: React.RefObject<T | null>): boolean {
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => setInView(entries.some((e) => e.isIntersecting)), { rootMargin: "100px" });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return inView;
}

/**
 * Desktop screenshot from GET api/desktops/:id/thumbnail, refreshed while on screen. The next frame is
 * preloaded off-DOM and swapped in only once decoded, so tiles never flash.
 */
export function Thumbnail({ desktop, className, refreshMs = THUMB_REFRESH_MS }: { desktop: DesktopSummary; className?: string; refreshMs?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref);
  const visible = usePageVisible();
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const live = desktop.status === "running";
  const show = desktop.status !== "starting";

  useEffect(() => {
    if (!show) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      const next = api.thumbnailUrl(desktop.id, Date.now());
      const img = new Image();
      img.decoding = "async";
      img.onload = () => {
        if (cancelled) return;
        setSrc(next);
        setFailed(false);
        if (live && inView && visible) timer = setTimeout(load, refreshMs);
      };
      img.onerror = () => {
        if (cancelled) return;
        setFailed(true);
        if (live && inView && visible) timer = setTimeout(load, refreshMs * 2);
      };
      img.src = next;
    };
    // Load once for stopped desktops; keep refreshing for running ones while in view.
    if (src === null || (live && inView && visible)) load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktop.id, show, live, inView, visible, refreshMs]);

  return (
    <div ref={ref} className={cn("relative h-full w-full overflow-hidden bg-tile", className)}>
      {!show ? (
        <div className="absolute inset-0 grid place-items-center text-xs text-muted">starting…</div>
      ) : src ? (
        <img
          src={src}
          alt=""
          draggable={false}
          className={cn("absolute inset-0 h-full w-full object-cover", desktop.status === "stopped" && "opacity-35 grayscale")}
        />
      ) : (
        <div className="absolute inset-0 grid place-items-center text-2xs text-faint">{failed ? "no preview" : ""}</div>
      )}
    </div>
  );
}
