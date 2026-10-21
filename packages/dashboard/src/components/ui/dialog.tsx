import * as D from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

export function DialogContent({
  title,
  description,
  children,
  className,
  wide,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  wide?: boolean;
}) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-40 bg-black/70 backdrop-blur-[1px]" />
      <D.Content
        className={cn(
          "fixed z-50 flex max-h-[92dvh] flex-col border border-line-strong bg-panel text-sm shadow-2xl outline-none",
          // phone: bottom sheet; desktop: centred
          "inset-x-0 bottom-0 rounded-t-lg sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-md",
          wide ? "sm:w-[min(960px,94vw)]" : "sm:w-[440px]",
          className,
        )}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <D.Title className="font-medium text-fg">{title}</D.Title>
          <D.Close className="text-muted hover:text-fg" aria-label="close">
            esc
          </D.Close>
        </div>
        {description ? <D.Description className="px-4 pt-3 text-xs text-muted">{description}</D.Description> : <D.Description className="sr-only">{String(title)}</D.Description>}
        <div className="min-h-0 overflow-y-auto px-4 py-3 pb-safe">{children}</div>
      </D.Content>
    </D.Portal>
  );
}

/** Label + control stacked, in the small lowercase style. */
export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-xs text-muted">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-2xs text-faint">{hint}</span> : null}
    </label>
  );
}

export const inputClass =
  "w-full rounded-sm border border-line-strong bg-bg px-2.5 py-1.5 text-sm text-fg placeholder:text-faint focus:border-muted focus:outline-none";
