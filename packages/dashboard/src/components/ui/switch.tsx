import * as S from "@radix-ui/react-switch";

export function Switch({ checked, onChange, label, id }: { checked: boolean; onChange: (v: boolean) => void; label?: string; id?: string }) {
  return (
    <S.Root
      id={id}
      checked={checked}
      onCheckedChange={onChange}
      aria-label={label}
      className="relative h-4 w-7 shrink-0 rounded-full border border-line-strong bg-bg transition-colors data-[state=checked]:border-green/60 data-[state=checked]:bg-green/20"
    >
      <S.Thumb className="block h-2.5 w-2.5 translate-x-0.5 rounded-full bg-muted transition-transform data-[state=checked]:translate-x-[13px] data-[state=checked]:bg-green" />
    </S.Root>
  );
}
