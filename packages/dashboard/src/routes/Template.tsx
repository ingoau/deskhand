import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TemplateDetail, TemplateVersion } from "@deskhand/shared";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent } from "../components/ui/dialog";
import { useToast } from "../components/ui/toast";
import { api, ApiError, errorMessage } from "../lib/api";
import { cn } from "../lib/cn";
import { ago, dateTime, formatBytes, since } from "../lib/format";
import { useNow } from "../lib/now";
import { keys, putDesktop, useTemplate } from "../lib/queries";
import { isEmptyDiff, versionHistory, type ListDiff, type VersionDiff } from "../lib/templateDiff";
import { FeedbackLine, Markers } from "./Templates";

export function TemplatePage() {
  const { name = "" } = useParams();
  const { data: t, error, isPending } = useTemplate(name);
  if (isPending) return <div className="px-4 py-6 text-muted sm:px-[18px]">loading…</div>;
  if (!t)
    return (
      <div className="px-4 py-6 sm:px-[18px]">
        <p className={error instanceof ApiError && error.status === 404 ? "text-muted" : "text-red"}>
          {error instanceof ApiError && error.status === 404 ? `No template named ${name}.` : errorMessage(error)}
        </p>
        <Link to="/templates" className="mt-3 inline-block text-amber">
          ‹ templates
        </Link>
      </div>
    );
  return <TemplateView t={t} />;
}

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="mt-7">
      <div className="mb-2 flex items-baseline gap-3 border-b border-line pb-1.5">
        <h2 className="text-muted">{title}</h2>
        {aside ? <div className="ml-auto text-2xs text-faint">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

function TemplateView({ t }: { t: TemplateDetail }) {
  const now = useNow();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const onDetail = (next: TemplateDetail) => {
    qc.setQueryData(keys.template(t.name), next);
    void qc.invalidateQueries({ queryKey: keys.templates });
  };
  const rollback = useMutation({
    mutationFn: (v: number) => api.rollbackTemplate(t.name, v),
    onSuccess: (next, v) => {
      onDetail(next);
      toast(`${t.name} now points at v${v}`, "ok");
    },
    onError: (e) => toast(errorMessage(e), "error"),
  });
  const setDefault = useMutation({
    mutationFn: () => api.setDefaultTemplate(t.name),
    onSuccess: (next) => {
      onDetail(next);
      toast(`${t.name} is now the default`, "ok");
    },
    onError: (e) => toast(errorMessage(e), "error"),
  });
  const del = useMutation({
    mutationFn: () => api.deleteTemplate(t.name),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.templates });
      toast(`deleted ${t.name}`, "ok");
      navigate("/templates");
    },
    onError: (e) => toast(errorMessage(e), "error"),
  });
  const rebuild = useMutation({
    mutationFn: () => api.rebuildTemplate(t.name),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: keys.template(t.name) });
      void qc.invalidateQueries({ queryKey: keys.templates });
      toast(`rebuilt ${t.name} as v${r.version}`, "ok");
    },
    onError: (e) => {
      void qc.invalidateQueries({ queryKey: keys.template(t.name) });
      toast(errorMessage(e), "error");
    },
  });
  const edit = useMutation({
    mutationFn: () => api.createDesktop({ template: t.name, name: `edit-${t.name}` }),
    onSuccess: (d) => {
      putDesktop(qc, d);
      void qc.invalidateQueries({ queryKey: keys.desktops });
      navigate(`/desktops/${d.id}`);
    },
    onError: (e) => toast(errorMessage(e), "error"),
  });

  const desc = t.description;
  const history = versionHistory(t.versions);

  return (
    <div className="pb-24 sm:pb-10">
      <div className="flex h-[46px] items-center px-4 sm:px-[18px]">
        <Link to="/templates" className="text-muted hover:text-fg">
          ‹ templates
        </Link>
      </div>
      <div className="max-w-[1000px] px-4 sm:px-[18px]">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-lg font-bold text-fg">{t.name}</h1>
          <span className="text-muted" data-testid="current-version">
            v{t.currentVersion}
          </span>
          <Markers t={t} />
        </div>
        <div className="mt-1 text-muted">
          updated {ago(t.updatedAt, now)} · last confirmed {t.lastConfirmedAt ? ago(t.lastConfirmedAt, now) : "never"}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => edit.mutate()} disabled={edit.isPending} title="start a desktop from this template; save it to add a version">
            {edit.isPending ? "starting…" : "edit"}
          </Button>
          <Button onClick={() => setDefault.mutate()} disabled={t.isDefault || setDefault.isPending}>
            {t.isDefault ? "default" : "set default"}
          </Button>
          {t.hasRecipe ? (
            <Button
              onClick={() => rebuild.mutate()}
              disabled={rebuild.isPending || t.rebuild?.status === "running" || t.rebuild?.status === "queued"}
              title="replay the recipe on the current base image and carry the logins over"
              data-testid="rebuild"
            >
              {rebuild.isPending || t.rebuild?.status === "running" ? "rebuilding…" : "rebuild"}
            </Button>
          ) : null}
          <Button variant="danger" onClick={() => setConfirmDelete(true)} disabled={t.isDefault}>
            delete
          </Button>
        </div>
        {t.baseVersion ? (
          <div className="mt-3 text-2xs text-faint" data-testid="template-base">
            base {t.baseVersion}
            {t.currentBaseVersion && t.currentBaseVersion !== t.baseVersion ? <span className="text-red/90"> · manager runs {t.currentBaseVersion}</span> : null}
            {t.outdatedBase && !t.hasRecipe ? " · snapshot only: save it again on the new base to update" : ""}
          </div>
        ) : null}
        {t.rebuild?.status === "failed" ? (
          <div className="mt-3 border-l-2 border-red pl-3 text-xs" data-testid="rebuild-failed">
            <div className="text-red">
              rebuild on base {t.rebuild.baseVersion} failed · {since(t.rebuild.at, now)} ago
            </div>
            {t.rebuild.error ? <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-2xs text-dim">{t.rebuild.error}</pre> : null}
          </div>
        ) : null}
        {t.stale && t.staleReason ? <div className="mt-2 text-xs text-amber/80">stale · {t.staleReason}</div> : null}

        <Section title="description">
          <dl className="grid grid-cols-[96px_1fr] gap-x-4 gap-y-1.5 sm:grid-cols-[120px_1fr]">
            <dt className="text-faint">summary</dt>
            <dd className="text-fg">{desc.summary}</dd>
            <dt className="text-faint">use when</dt>
            <dd className="text-fg">{desc.use_when}</dd>
            {desc.not_for ? (
              <>
                <dt className="text-faint">not for</dt>
                <dd className="text-fg">{desc.not_for}</dd>
              </>
            ) : null}
            {desc.setup_notes ? (
              <>
                <dt className="text-faint">setup notes</dt>
                <dd className="text-fg">{desc.setup_notes}</dd>
              </>
            ) : null}
            {desc.tags?.length ? (
              <>
                <dt className="text-faint">tags</dt>
                <dd className="text-dim">{desc.tags.join(", ")}</dd>
              </>
            ) : null}
            <dt className="text-faint">logged in</dt>
            <dd className="text-dim">{t.loggedInSites.length ? t.loggedInSites.join(", ") : "no logins"}</dd>
            {t.extensions?.length ? (
              <>
                <dt className="text-faint">extensions</dt>
                <dd className="text-dim">{t.extensions.join(", ")}</dd>
              </>
            ) : null}
          </dl>
          {t.loggedInSites.length ? (
            <p className="mt-2 text-2xs text-faint">every agent that starts from this template can use these logins.</p>
          ) : null}
        </Section>

        <Section title="versions" aside="last 5 versions and any in use are kept">
          <ol>
            {history.map(({ version: v, diff }) => (
              <VersionRow
                key={v.version}
                v={v}
                diff={diff}
                current={v.version === t.currentVersion}
                newer={v.version > t.currentVersion}
                now={now}
                onRollback={() => rollback.mutate(v.version)}
                pending={rollback.isPending && rollback.variables === v.version}
              />
            ))}
          </ol>
        </Section>

        <Section title="feedback">
          {t.feedback.length ? (
            <ul className="space-y-1.5">
              {t.feedback.map((f, i) => (
                <li key={i} className="flex flex-wrap gap-x-2">
                  <FeedbackLine f={f} now={now} />
                  <span className="text-faint">
                    v{f.version}
                    {f.session ? ` · ${f.session}` : f.by ? ` · ${f.by}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-faint">no feedback yet. agents report with template_feedback.</p>
          )}
        </Section>

        <RecipeSection t={t} onDetail={onDetail} />
      </div>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent title={`delete ${t.name}?`}>
          <p className="mb-4 text-muted">Removes the template and its image versions. Desktops already running from it keep working.</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              cancel
            </Button>
            <Button variant="danger" onClick={() => del.mutate()} disabled={del.isPending}>
              {del.isPending ? "deleting…" : "delete template"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The current version's recipe, editable in place (metadata only; replayed on the next rebuild). */
function RecipeSection({ t, onDetail }: { t: TemplateDetail; onDetail: (d: TemplateDetail) => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (recipe: string | null) => api.setTemplateRecipe(t.name, recipe),
    onSuccess: (next) => {
      onDetail(next);
      setDraft(null);
      toast(next.recipe ? "recipe saved" : "recipe removed", "ok");
    },
    onError: (e) => toast(errorMessage(e), "error"),
  });
  const editing = draft !== null;
  return (
    <Section
      title="recipe"
      aside={
        !editing ? (
          <button className="text-muted hover:text-fg" onClick={() => setDraft(t.recipe ?? "")} data-testid="edit-recipe">
            {t.recipe ? "edit" : "add a recipe"}
          </button>
        ) : (
          "replayed on a new base image; logins are carried over from the snapshot"
        )
      }
    >
      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(draft.trim() ? draft : null);
          }}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.min(18, Math.max(5, draft.split("\n").length + 1))}
            spellCheck={false}
            aria-label="recipe"
            placeholder={"# runs with bash -e as the agent user; '# deskhand: run-as=root' in the first lines runs it as root\napt-get install -y jq"}
            className="w-full rounded-sm border border-line-strong bg-bg p-3 font-mono text-xs text-fg placeholder:text-faint focus:border-amber focus:outline-none"
          />
          <div className="mt-2 flex gap-2">
            <Button type="submit" variant="primary" size="sm" disabled={save.isPending}>
              {save.isPending ? "saving…" : "save recipe"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
              cancel
            </Button>
          </div>
        </form>
      ) : t.recipe ? (
        <pre className="overflow-x-auto rounded-sm border border-line bg-panel p-3 text-xs text-dim" data-testid="recipe">
          {t.recipe}
        </pre>
      ) : (
        <p className="text-faint">snapshot only: without a recipe this template can't be rebuilt when the base image updates.</p>
      )}
    </Section>
  );
}

function ListChanges({ label, d }: { label: string; d: ListDiff }) {
  if (!d.added.length && !d.removed.length) return null;
  return (
    <div className="flex flex-wrap gap-x-2">
      <span className="text-faint">{label}</span>
      {d.added.map((x) => (
        <span key={"+" + x} className="text-green">
          +{x}
        </span>
      ))}
      {d.removed.map((x) => (
        <span key={"-" + x} className="text-red">
          −{x}
        </span>
      ))}
    </div>
  );
}

function DiffView({ diff }: { diff: VersionDiff }) {
  if (diff.initial) {
    return (
      <div className="space-y-0.5 text-xs">
        <div className="text-faint">first version</div>
        <ListChanges label="sites" d={diff.loggedInSites} />
        <ListChanges label="extensions" d={diff.extensions} />
        <ListChanges label="packages" d={diff.packages} />
      </div>
    );
  }
  if (isEmptyDiff(diff)) return <div className="text-xs text-faint">no description or manifest changes</div>;
  return (
    <div className="space-y-0.5 text-xs" data-testid="version-diff">
      {diff.description.map((c) => (
        <div key={c.field}>
          <span className="text-faint">{c.field.replace("_", " ")} </span>
          {c.before ? <span className="text-red line-through decoration-red/50">{c.before}</span> : null}
          {c.before && c.after ? <span className="text-faint"> → </span> : null}
          {c.after ? <span className="text-green">{c.after}</span> : <span className="text-faint">(removed)</span>}
        </div>
      ))}
      <ListChanges label="sites" d={diff.loggedInSites} />
      <ListChanges label="extensions" d={diff.extensions} />
      <ListChanges label="packages" d={diff.packages} />
      {diff.baseChanged ? (
        <div>
          <span className="text-faint">base </span>
          {diff.baseChanged.before} → {diff.baseChanged.after}
        </div>
      ) : null}
      {diff.recipeChanged ? (
        <div>
          <span className="text-faint">recipe </span>
          {diff.recipeChanged.before === diff.recipeChanged.after ? "changed" : diff.recipeChanged.after ? "added" : "removed"}
        </div>
      ) : null}
    </div>
  );
}

function VersionRow({
  v,
  diff,
  current,
  newer,
  now,
  onRollback,
  pending,
}: {
  v: TemplateVersion;
  diff: VersionDiff;
  current: boolean;
  newer: boolean;
  now: number;
  onRollback: () => void;
  pending: boolean;
}) {
  return (
    <li className={cn("grid grid-cols-[48px_1fr] gap-3 border-b border-line py-3 sm:grid-cols-[56px_1fr_auto]", current && "bg-panel/60")} data-testid="version-row" data-version={v.version}>
      <div className={cn("font-medium", current ? "text-fg" : "text-muted")}>v{v.version}</div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 text-muted">
          {current ? <span className="text-green">current</span> : null}
          <span title={dateTime(v.createdAt)}>{since(v.createdAt, now)} ago</span>
          <span>· {v.savedBy ?? "built in"}</span>
          {v.byAgent ? <span className="text-amber">· by agent</span> : null}
          <span className="text-faint">
            · base {v.baseVersion} · recipe {v.hasRecipe ? "yes" : "no"}
            {v.sizeBytes ? ` · ${formatBytes(v.sizeBytes)}` : ""}
            {v.inUse ? ` · ${v.inUse} in use` : ""}
          </span>
        </div>
        {v.savedFrom || v.rebuiltFrom ? (
          <div className="mt-0.5 text-2xs text-faint" data-testid="version-provenance">
            {v.rebuiltFrom ? `rebuilt from v${v.rebuiltFrom} on a new base` : null}
            {v.savedFrom ? `saved from ${v.savedFrom.title ? `“${v.savedFrom.title}”` : v.savedFrom.desktop}${v.savedFrom.session ? ` · ${v.savedFrom.session}` : ""}` : null}
          </div>
        ) : null}
        <div className="mt-1">
          <DiffView diff={diff} />
        </div>
        {v.manifestNotes?.length ? <div className="mt-1 text-2xs text-amber/70">{v.manifestNotes.join(" · ")}</div> : null}
      </div>
      <div className="col-start-2 sm:col-start-auto">
        {!current ? (
          <Button size="sm" onClick={onRollback} disabled={pending} data-testid={`rollback-v${v.version}`}>
            {pending ? "switching…" : newer ? `restore v${v.version}` : `rollback to v${v.version}`}
          </Button>
        ) : null}
      </div>
    </li>
  );
}
