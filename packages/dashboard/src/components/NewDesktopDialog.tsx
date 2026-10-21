import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "../lib/api";
import { cn } from "../lib/cn";
import { keys, putDesktop, useTemplates } from "../lib/queries";
import { Button } from "./ui/button";
import { Dialog, DialogContent, Field, inputClass } from "./ui/dialog";
import { Switch } from "./ui/switch";

export function NewDesktopDialog({ open, onOpenChange, template: initial }: { open: boolean; onOpenChange: (v: boolean) => void; template?: string }) {
  const { data: templates } = useTemplates();
  const [template, setTemplate] = useState<string | undefined>(initial);
  const [name, setName] = useState("");
  const [persistent, setPersistent] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();

  useEffect(() => {
    if (open && !template && templates?.length) setTemplate((templates.find((t) => t.isDefault) ?? templates[0])!.name);
  }, [open, template, templates]);

  const create = useMutation({
    mutationFn: () => api.createDesktop({ template, name: name.trim() || undefined, persistent }),
    onSuccess: (d) => {
      qc.setQueryData(keys.desktops, (list: unknown) => (Array.isArray(list) ? [...list, d] : list));
      putDesktop(qc, d);
      void qc.invalidateQueries({ queryKey: keys.system });
      onOpenChange(false);
      setName("");
      navigate(`/desktops/${d.id}`);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="new desktop">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div className="mb-1 text-xs text-muted">template</div>
          <div className="mb-3 max-h-[40dvh] overflow-y-auto rounded-sm border border-line" role="radiogroup" aria-label="template">
            {templates?.map((t) => (
              <button
                key={t.name}
                type="button"
                role="radio"
                aria-checked={template === t.name}
                onClick={() => setTemplate(t.name)}
                className={cn("block w-full border-b border-line px-3 py-2 text-left last:border-b-0", template === t.name ? "bg-raised" : "hover:bg-raised/60")}
              >
                <div className="flex items-center gap-2">
                  <span className={cn("h-[6px] w-[6px] rounded-full", template === t.name ? "bg-amber" : "bg-line-strong")} />
                  <span className="font-medium text-fg">{t.name}</span>
                  <span className="text-faint">v{t.currentVersion}</span>
                  {t.isDefault ? <span className="text-2xs text-muted">default</span> : null}
                </div>
                <div className="mt-0.5 truncate pl-[14px] text-xs text-muted">{t.description.summary}</div>
              </button>
            )) ?? <div className="px-3 py-2 text-muted">loading…</div>}
          </div>
          <Field label="title (optional)">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. vendor-onboarding" autoComplete="off" />
          </Field>
          <label className="mb-4 flex items-center justify-between gap-3">
            <span>
              <span className="block text-sm text-fg">persistent</span>
              <span className="block text-2xs text-faint">kept after its session ends</span>
            </span>
            <Switch checked={persistent} onChange={setPersistent} label="persistent" />
          </label>
          {create.error ? <p className="mb-3 text-xs text-red">{errorMessage(create.error)}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!template || create.isPending}>
              {create.isPending ? "starting…" : "start desktop"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
