import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

const NowCtx = createContext<number>(Date.now());

/** One shared 1 s clock so every uptime/age label ticks together. */
export function NowProvider({ children, interval = 1000 }: { children: ReactNode; interval?: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(t);
  }, [interval]);
  return <NowCtx.Provider value={now}>{children}</NowCtx.Provider>;
}

export function useNow(): number {
  return useContext(NowCtx);
}

/** Matches Tailwind's `sm` breakpoint by default. */
export function useMediaQuery(query = "(min-width: 640px)"): boolean {
  const get = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [match, setMatch] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}

/** True while the page is visible. */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return visible;
}
