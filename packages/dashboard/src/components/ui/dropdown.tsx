import * as M from "@radix-ui/react-dropdown-menu";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export const Menu = M.Root;
export const MenuTrigger = M.Trigger;

export function MenuContent({ children, align = "end", side }: { children: ReactNode; align?: "start" | "end"; side?: "top" | "bottom" }) {
  return (
    <M.Portal>
      <M.Content
        align={align}
        side={side}
        sideOffset={6}
        collisionPadding={8}
        className="z-50 min-w-[220px] rounded-sm border border-line-strong bg-panel p-1 text-sm shadow-xl"
      >
        {children}
      </M.Content>
    </M.Portal>
  );
}

export function MenuItem({
  children,
  onSelect,
  danger,
  disabled,
  hint,
}: {
  children: ReactNode;
  onSelect?: (e: Event) => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: ReactNode;
}) {
  return (
    <M.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        "flex cursor-pointer select-none items-center justify-between gap-6 rounded-sm px-2.5 py-2 outline-none data-[disabled]:cursor-default data-[disabled]:opacity-40 data-[highlighted]:bg-raised sm:py-1.5",
        danger ? "text-red" : "text-fg",
      )}
    >
      <span>{children}</span>
      {hint ? <span className="text-2xs text-faint">{hint}</span> : null}
    </M.Item>
  );
}

export function MenuCheckbox({ children, checked, onChange }: { children: ReactNode; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <M.CheckboxItem
      checked={checked}
      onCheckedChange={(v) => onChange(v === true)}
      onSelect={(e) => e.preventDefault()}
      className="flex cursor-pointer select-none items-center justify-between gap-6 rounded-sm px-2.5 py-2 text-fg outline-none data-[highlighted]:bg-raised sm:py-1.5"
    >
      <span>{children}</span>
      <span className={cn("text-2xs", checked ? "text-green" : "text-faint")}>{checked ? "on" : "off"}</span>
    </M.CheckboxItem>
  );
}

export function MenuSeparator() {
  return <M.Separator className="my-1 h-px bg-line" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <M.Label className="px-2.5 pb-1 pt-1.5 text-2xs text-faint">{children}</M.Label>;
}
