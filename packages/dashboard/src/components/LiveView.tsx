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
  /**
   * 1:1 instead of scaled to fit: the desktop is shown at its real pixel size and dragging pans it (taps still
   * click in control mode). For reading small text and hitting small targets on a phone.
   */
  actualSize?: boolean;
  className?: string;
  onRfb?: (rfb: RFB | null) => void;
  onClipboard?: (text: string) => void;
  onState?: (s: LiveState) => void;
  /** The connection dropped (e.g. the daemon closed a stale control connection); refresh the desktop's state. */
  onDropped?: () => void;
}

/** Reconnect delay after `failures` consecutive drops: 0.5 s, 1 s, 2 s … capped at 10 s, with jitter. */
export function reconnectDelay(failures: number): number {
  return Math.min(10_000, 500 * 2 ** Math.max(0, Math.min(failures - 1, 5))) + Math.floor(Math.random() * 250);
}

function applyScaling(rfb: RFB, actualSize: boolean) {
  rfb.scaleViewport = !actualSize;
  rfb.clipViewport = actualSize;
  rfb.dragViewport = actualSize;
}

/**
 * noVNC client over `{base}api/desktops/:id/vnc?mode=view|control[&generation=N]`. Scales to fit by default.
 * Falls back to the refreshing thumbnail while connecting, when the connection drops, and in mock mode.
 * View mode never sends input (and the daemon drops any that arrives); control mode reconnects with the new
 * generation whenever control changes.
 */
export function LiveView({ desktop, control, generation, actualSize = false, className, onRfb, onClipboard, onState, onDropped }: LiveViewProps) {
  const target = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const [state, setState] = useState<LiveState>(IS_MOCK ? "unavailable" : "connecting");
  const [retryKey, setRetryKey] = useState(0);
  const failures = useRef(0);
  const running = desktop.status === "running";
  const cb = useRef({ onRfb, onClipboard, onState, onDropped, actualSize });
  cb.current = { onRfb, onClipboard, onState, onDropped, actualSize };

  useEffect(() => {
    cb.current.onState?.(state);
  }, [state]);

  useEffect(() => {
    if (IS_MOCK || !running || !target.current) return;
    let rfb: RFB | null = null;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    setState(failures.current ? "disconnected" : "connecting");
    import("@novnc/novnc")
      .then(({ default: RFBClass }) => {
        if (cancelled || !target.current) return;
        const q = control ? `mode=control&generation=${generation}` : "mode=view";
        const r = new RFBClass(target.current, wsUrl(`api/desktops/${encodeURIComponent(desktop.id)}/vnc?${q}`), { shared: true });
        rfb = r;
        r.viewOnly = !control;
        applyScaling(r, cb.current.actualSize);
        r.resizeSession = false;
        r.focusOnClick = control;
        r.showDotCursor = control;
        r.background = "#1c1d20";
        r.qualityLevel = 6;
        r.compressionLevel = 2;
        r.addEventListener("connect", () => {
          failures.current = 0;
          rfbRef.current = r;
          setState("connected");
          cb.current.onRfb?.(r);
          if (control) r.focus({ preventScroll: true });
        });
        r.addEventListener("disconnect", () => {
          rfbRef.current = null;
          cb.current.onRfb?.(null);
          if (cancelled) return;
          setState("disconnected");
          cb.current.onDropped?.();
          failures.current += 1;
          retry = setTimeout(() => setRetryKey((k) => k + 1), reconnectDelay(failures.current));
        });
        r.addEventListener("clipboard", (e) => cb.current.onClipboard?.((e as CustomEvent<{ text: string }>).detail.text));
        // The daemon proxy needs no VNC password; if the server asks for one, show the thumbnail instead.
        r.addEventListener("credentialsrequired", () => {
          cancelled = true;
          setState("unavailable");
          r.disconnect();
        });
      })
      .catch(() => !cancelled && setState("unavailable"));
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      rfbRef.current = null;
      cb.current.onRfb?.(null);
      try {
        rfb?.disconnect();
      } catch {
        /* already closed */
      }
    };
  }, [desktop.id, control, generation, running, retryKey]);

  // Switching between fit and 1:1 needs no reconnect.
  useEffect(() => {
    if (rfbRef.current && state === "connected") applyScaling(rfbRef.current, actualSize);
  }, [actualSize, state]);

  const showFallback = state !== "connected";
  // View-only at fit size: let touches and clicks fall through to the page (scroll, pinch-zoom the page).
  const passThrough = !control && !actualSize;
  return (
    <div
      className={cn("relative h-full w-full overflow-hidden bg-tile", className)}
      data-testid="live-view"
      data-live-state={IS_MOCK ? "mock" : state}
      data-live-mode={control ? "control" : "view"}
    >
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
                      ? "live view disconnected · reconnecting…"
                      : "live view unavailable · showing thumbnail"}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
      {/* noVNC renders its canvas into this element */}
      <div ref={target} className={cn("absolute inset-0", showFallback && "opacity-0", passThrough ? "pointer-events-none" : "touch-none")} />
    </div>
  );
}
