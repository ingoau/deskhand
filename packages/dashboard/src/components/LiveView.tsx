import { useEffect, useRef, useState } from "react";
import type RFB from "@novnc/novnc";
import type { DesktopSummary } from "@deskhand/shared";
import { IS_MOCK, wsUrl } from "../lib/base";
import { cn } from "../lib/cn";
import { Thumbnail } from "./Thumbnail";

export type LiveState = "connecting" | "connected" | "disconnected" | "unavailable";

export interface LiveViewProps {
  desktop: DesktopSummary;
  /** Interactive (after takeover) vs view-only. */
  control: boolean;
  /** Generation from the lock response; control connections from an older one are closed by the daemon. */
  generation: number;
  className?: string;
  onRfb?: (rfb: RFB | null) => void;
  onClipboard?: (text: string) => void;
  onState?: (s: LiveState) => void;
}

/**
 * noVNC client over `{base}api/desktops/:id/vnc?mode=view|control[&generation=N]`. Scales to fit.
 * Falls back to the refreshing thumbnail while connecting, when the connection drops, and in mock mode.
 */
export function LiveView({ desktop, control, generation, className, onRfb, onClipboard, onState }: LiveViewProps) {
  const target = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<LiveState>(IS_MOCK ? "unavailable" : "connecting");
  const [attempt, setAttempt] = useState(0);
  const running = desktop.status === "running";
  const cb = useRef({ onRfb, onClipboard, onState });
  cb.current = { onRfb, onClipboard, onState };

  useEffect(() => {
    cb.current.onState?.(state);
  }, [state]);

  useEffect(() => {
    if (IS_MOCK || !running || !target.current) return;
    let rfb: RFB | null = null;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    setState("connecting");
    import("@novnc/novnc")
      .then(({ default: RFBClass }) => {
        if (cancelled || !target.current) return;
        const q = control ? `mode=control&generation=${generation}` : "mode=view";
        rfb = new RFBClass(target.current, wsUrl(`api/desktops/${encodeURIComponent(desktop.id)}/vnc?${q}`), { shared: true });
        rfb.viewOnly = !control;
        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfb.clipViewport = false;
        rfb.focusOnClick = control;
        rfb.showDotCursor = control;
        rfb.background = "#1c1d20";
        rfb.qualityLevel = 6;
        rfb.addEventListener("connect", () => {
          setState("connected");
          cb.current.onRfb?.(rfb);
          if (control) rfb?.focus({ preventScroll: true });
        });
        rfb.addEventListener("disconnect", () => {
          cb.current.onRfb?.(null);
          if (cancelled) return;
          setState("disconnected");
          // Reconnect with a gentle backoff; a generation change re-runs this effect anyway.
          retry = setTimeout(() => setAttempt((a) => a + 1), Math.min(10_000, 1500 * 2 ** Math.min(attempt, 3)));
        });
        rfb.addEventListener("clipboard", (e) => cb.current.onClipboard?.((e as CustomEvent<{ text: string }>).detail.text));
        // The daemon proxy needs no VNC password; if the server asks for one, show the thumbnail instead.
        rfb.addEventListener("credentialsrequired", () => {
          setState("unavailable");
          rfb?.disconnect();
        });
      })
      .catch(() => !cancelled && setState("unavailable"));
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      cb.current.onRfb?.(null);
      try {
        rfb?.disconnect();
      } catch {
        /* already closed */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktop.id, control, generation, running, attempt]);

  const showFallback = state !== "connected";
  return (
    <div className={cn("relative h-full w-full overflow-hidden bg-tile", className)} data-testid="live-view" data-live-state={IS_MOCK ? "mock" : state}>
      {showFallback ? (
        <div className="absolute inset-0">
          <Thumbnail desktop={desktop} />
          {running ? (
            <div className="absolute inset-x-0 bottom-0 flex justify-center p-2">
              <span className="rounded-sm bg-black/70 px-2 py-0.5 text-2xs text-dim">
                {IS_MOCK
                  ? "live view unavailable in mock"
                  : state === "connecting"
                    ? "connecting live view…"
                    : state === "disconnected"
                      ? "live view disconnected · retrying"
                      : "live view unavailable · showing thumbnail"}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
      {/* noVNC renders its canvas into this element */}
      <div ref={target} className={cn("absolute inset-0", showFallback && "opacity-0", control ? "touch-none" : "pointer-events-none")} />
    </div>
  );
}
