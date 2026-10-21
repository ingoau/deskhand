import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

type Variant = "default" | "primary" | "violet" | "ghost" | "danger" | "link";
type Size = "sm" | "md" | "lg" | "icon";

const variants: Record<Variant, string> = {
  default: "border border-line-strong bg-transparent text-fg hover:border-muted hover:bg-raised",
  primary: "bg-amber text-amber-ink font-medium hover:brightness-110 border border-amber",
  violet: "bg-violet text-[#120e24] font-medium hover:brightness-110 border border-violet",
  ghost: "text-muted hover:text-fg hover:bg-raised",
  danger: "border border-[#4a2420] text-red hover:bg-red-bg",
  link: "text-amber hover:underline underline-offset-4 px-0",
};

const sizes: Record<Size, string> = {
  sm: "h-7 px-2.5 text-xs",
  md: "h-8 px-3 text-sm",
  lg: "h-12 px-5 text-base",
  icon: "h-8 w-8 text-sm",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "default", size = "md", className, type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-sm transition-colors disabled:opacity-40",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
});
