import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";

type Tone = "info" | "error" | "ok";
interface Toast {
  id: number;
  text: string;
  tone: Tone;
}

const Ctx = createContext<(text: string, tone?: Tone) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Tone = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "error" ? 6000 : 3000);
  }, []);
  const value = useMemo(() => push, [push]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 sm:bottom-6 sm:items-end sm:px-6" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              "pointer-events-auto max-w-md rounded-sm border bg-panel px-3 py-2 text-xs shadow-xl",
              t.tone === "error" ? "border-[#4a2420] text-red" : t.tone === "ok" ? "border-green/40 text-fg" : "border-line-strong text-fg",
            )}
          >
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  return useContext(Ctx);
}
