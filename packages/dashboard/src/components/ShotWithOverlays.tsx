import { useEffect, useId, useRef, useState } from "react";
import type { Overlay } from "@deskhand/shared";
import { arrowHead, crosshair, polygonPoints, polylinePoints, regionRect, unitFor, type Screen } from "../lib/overlays";
import { cn } from "../lib/cn";

const POINT = "#f0a43a";
const PATH = "#5b9cf6";
const REGION = "#9d8cf7";

/** Draws click points, drag paths and zoom regions in screen coordinates over `src`. */
export function ShotWithOverlays({
  src,
  overlays,
  screen,
  className,
  alt = "",
}: {
  src: string | null;
  overlays: readonly Overlay[];
  screen: Screen;
  className?: string;
  alt?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const u = unitFor(screen.width, width || screen.width);
  const fid = "ov" + useId().replace(/[^a-zA-Z0-9]/g, "");

  return (
    <div ref={ref} className={cn("relative overflow-hidden bg-tile", className)} style={{ aspectRatio: `${screen.width} / ${screen.height}` }}>
      {src ? <img src={src} alt={alt} loading="lazy" draggable={false} className="absolute inset-0 h-full w-full object-fill" /> : null}
      {overlays.length ? (
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox={`0 0 ${screen.width} ${screen.height}`}
          preserveAspectRatio="none"
          data-testid="overlays"
          aria-hidden
        >
          <defs>
            <filter id={fid} x="-50%" y="-50%" width="200%" height="200%">
              <feDropShadow dx="0" dy="0" stdDeviation={1.2 * u} floodColor="#000" floodOpacity="0.7" />
            </filter>
          </defs>
          <g filter={`url(#${fid})`}>
            {overlays.map((o, i) => {
              if (o.kind === "region") {
                const r = regionRect(o.region);
                return (
                  <g key={i} data-overlay="region">
                    <rect {...r} fill={REGION} fillOpacity={0.12} stroke={REGION} strokeWidth={1.5 * u} strokeDasharray={`${5 * u} ${3 * u}`} />
                  </g>
                );
              }
              if (o.kind === "path") {
                const head = arrowHead(o.points, u);
                return (
                  <g key={i} data-overlay="path">
                    <polyline points={polylinePoints(o.points)} fill="none" stroke={PATH} strokeWidth={2 * u} strokeLinejoin="round" strokeLinecap="round" />
                    {head ? <polygon points={polygonPoints(head)} fill={PATH} /> : null}
                  </g>
                );
              }
              const c = crosshair(o.at, u);
              return (
                <g key={i} data-overlay="point">
                  <circle {...c.circle} fill="none" stroke={POINT} strokeWidth={1.75 * u} />
                  <circle {...c.dot} fill={POINT} />
                  {c.lines.map(([x1, y1, x2, y2], j) => (
                    <line key={j} x1={x1} y1={y1} x2={x2} y2={y2} stroke={POINT} strokeWidth={1.5 * u} strokeLinecap="round" />
                  ))}
                  {o.label ? (
                    <text x={c.label.x} y={c.label.y} fill={POINT} fontSize={11 * u} fontFamily="JetBrains Mono, monospace">
                      {o.label}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </g>
        </svg>
      ) : null}
    </div>
  );
}
