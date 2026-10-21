import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DesktopSummary } from "@deskhand/shared";
import { api, errorMessage } from "../lib/api";
import { displayTitle } from "../lib/desktop";
import { formatBytes } from "../lib/format";
import { keys } from "../lib/queries";
import { Button } from "./ui/button";
import { Dialog, DialogContent, Field, inputClass } from "./ui/dialog";
import { useToast } from "./ui/toast";

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

export function SaveTemplateDialog({ desktop, open, onOpenChange }: { desktop: DesktopSummary; open: boolean; onOpenChange: (v: boolean) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: "", summary: "", use_when: "", not_for: "", setup_notes: "", tags: "" });
  useEffect(() => {
    if (open) setForm((f) => ({ ...f, name: f.name || (desktop.template !== "base" ? desktop.template : slug(displayTitle(desktop))) }));
  }, [open, desktop]);
  const save = useMutation({
    mutationFn: () =>
      api.saveAsTemplate(desktop.id, {
        name: form.name.trim(),
        description: {
          summary: form.summary.trim(),
          use_when: form.use_when.trim(),
          ...(form.not_for.trim() ? { not_for: form.not_for.trim() } : {}),
          ...(form.setup_notes.trim() ? { setup_notes: form.setup_notes.trim() } : {}),
          ...(form.tags.trim()
            ? {
                tags: form.tags
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean),
              }
            : {}),
        },
      }),
    onSuccess: (r) => {
      toast(`saved ${r.template.name} v${r.version}`, "ok");
      void qc.invalidateQueries({ queryKey: keys.templates });
      onOpenChange(false);
    },
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="save as template"
        description="Closes Chromium (flushing cookies), clears caches, downloads and /tmp, then snapshots this desktop as a new template version. Every login in it is usable by every agent that starts from it."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Field label="name" hint="an existing name adds a new version; nothing is overwritten">
            <input className={inputClass} value={form.name} onChange={set("name")} required pattern="[a-z0-9][a-z0-9-]*" autoComplete="off" />
          </Field>
          <Field label="summary *">
            <input className={inputClass} value={form.summary} onChange={set("summary")} required placeholder="Chromium logged into GitHub and Linear as the bot account" />
          </Field>
          <Field label="use when *">
            <input className={inputClass} value={form.use_when} onChange={set("use_when")} required placeholder="Triaging issues or reviewing PRs in the web UI" />
          </Field>
          <Field label="not for">
            <input className={inputClass} value={form.not_for} onChange={set("not_for")} placeholder="Anything needing the personal Google account" />
          </Field>
          <Field label="setup notes">
            <textarea className={inputClass} rows={2} value={form.setup_notes} onChange={set("setup_notes")} placeholder="Linear opens to the Triage view" />
          </Field>
          <Field label="tags" hint="comma separated">
            <input className={inputClass} value={form.tags} onChange={set("tags")} placeholder="github, linear, web" />
          </Field>
          {save.error ? <p className="mb-3 text-xs text-red">{errorMessage(save.error)}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              cancel
            </Button>
            <Button type="submit" variant="primary" disabled={save.isPending}>
              {save.isPending ? "saving… (quiesce + snapshot)" : "save template"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function UploadDialog({ desktop, file, onClose }: { desktop: DesktopSummary; file: File | null; onClose: () => void }) {
  const toast = useToast();
  const [path, setPath] = useState("");
  useEffect(() => {
    if (file) setPath(`/home/agent/Downloads/${file.name}`);
  }, [file]);
  const up = useMutation({
    mutationFn: () => api.uploadFile(desktop.id, file!, path.trim()),
    onSuccess: (r) => {
      toast(`uploaded ${formatBytes(r.bytes)} to ${r.path}`, "ok");
      onClose();
    },
  });
  return (
    <Dialog open={!!file} onOpenChange={(v) => !v && onClose()}>
      <DialogContent title="upload file">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            up.mutate();
          }}
        >
          <p className="mb-3 text-xs text-muted">
            {file?.name} · {formatBytes(file?.size)}
          </p>
          <Field label="save to (inside the desktop)">
            <input className={inputClass} value={path} onChange={(e) => setPath(e.target.value)} required pattern="/.*" />
          </Field>
          {up.error ? <p className="mb-3 text-xs text-red">{errorMessage(up.error)}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              cancel
            </Button>
            <Button type="submit" variant="primary" disabled={up.isPending}>
              {up.isPending ? "uploading…" : "upload"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DownloadDialog({ desktop, open, onOpenChange }: { desktop: DesktopSummary; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [path, setPath] = useState("/home/agent/Downloads/");
  const [error, setError] = useState<string | null>(null);
  const valid = path.startsWith("/") && !path.endsWith("/");
  const href = valid ? api.fileUrl(desktop.id, path) : undefined;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="download file">
        <Field label="path inside the desktop">
          <input
            className={inputClass}
            value={path}
            onChange={(e) => {
              setPath(e.target.value);
              setError(null);
            }}
            autoFocus
          />
        </Field>
        {error ? (
          <p className="mb-3 text-xs text-red" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            cancel
          </Button>
          <a
            href={href}
            download
            aria-disabled={!valid}
            onClick={async (e) => {
              if (!href || e.currentTarget.dataset.checked) return;
              // Check first, so a missing file shows a message instead of downloading an error body.
              e.preventDefault();
              const a = e.currentTarget;
              const res = await fetch(href, { method: "HEAD", credentials: "same-origin" }).catch(() => null);
              if (!res?.ok) {
                // HEAD has no body: fetch the (small, JSON) error once more for the manager's message.
                const body = res ? await fetch(href, { credentials: "same-origin" }).then((r) => (r.ok ? null : r.json().catch(() => null))).catch(() => null) : null;
                const msg = (body as { error?: { message?: string } } | null)?.error?.message;
                setError(msg ?? (res?.status === 404 ? `No file at ${path}.` : `Couldn't download ${path}${res ? ` (${res.status})` : ""}.`));
                return;
              }
              a.dataset.checked = "1";
              a.click();
              delete a.dataset.checked;
              setTimeout(() => onOpenChange(false), 100);
            }}
            className={`inline-flex h-8 items-center rounded-sm border border-amber bg-amber px-3 font-medium text-amber-ink ${valid ? "" : "pointer-events-none opacity-40"}`}
          >
            download
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function KillDialog({ desktop, open, onOpenChange, onKilled }: { desktop: DesktopSummary; open: boolean; onOpenChange: (v: boolean) => void; onKilled: () => void }) {
  const qc = useQueryClient();
  const kill = useMutation({
    mutationFn: () => api.killDesktop(desktop.id),
    onSuccess: () => {
      qc.setQueryData<DesktopSummary[]>(keys.desktops, (l) => l?.filter((d) => d.id !== desktop.id));
      qc.removeQueries({ queryKey: keys.desktop(desktop.id) });
      onOpenChange(false);
      onKilled();
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={`kill ${displayTitle(desktop)}?`}>
        <p className="mb-4 text-muted">
          Removes container <span className="text-fg">{desktop.name}</span> and everything in it that isn't in a mounted folder. The agent's next call gets{" "}
          <span className="text-fg">desktop_not_found</span>.
        </p>
        {kill.error ? <p className="mb-3 text-xs text-red">{errorMessage(kill.error)}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            cancel
          </Button>
          <Button variant="danger" onClick={() => kill.mutate()} disabled={kill.isPending} data-testid="confirm-kill">
            {kill.isPending ? "killing…" : "kill desktop"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
