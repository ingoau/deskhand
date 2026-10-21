import { useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MobileHeader } from "../components/Nav";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, inputClass } from "../components/ui/dialog";
import { useToast } from "../components/ui/toast";
import { api, errorMessage, type CreatedToken } from "../lib/api";
import { ago, formatBytes } from "../lib/format";
import { useNow } from "../lib/now";
import { keys, useSystem, useTokens } from "../lib/queries";

function Section({ title, children, hint }: { title: string; children: React.ReactNode; hint?: string }) {
  return (
    <section className="mt-7">
      <div className="mb-2 border-b border-line pb-1.5">
        <h2 className="text-muted">{title}</h2>
        {hint ? <p className="mt-0.5 text-2xs text-faint">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function Settings() {
  const now = useNow();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const { data: system } = useSystem();
  const { data: tokens, error: tokensError } = useTokens();
  const [name, setName] = useState("");
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const [confirmLogout, setConfirmLogout] = useState(false);

  const create = useMutation({
    mutationFn: () => api.createToken(name.trim()),
    onSuccess: (r) => {
      setCreated(r);
      setName("");
      void qc.invalidateQueries({ queryKey: keys.tokens });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeToken(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.tokens });
      toast("token revoked", "ok");
    },
    onError: (e) => toast(errorMessage(e), "error"),
  });
  const logoutAll = useMutation({
    mutationFn: api.logoutAll,
    onSuccess: () => {
      qc.clear();
      navigate("/login", { replace: true });
    },
    onError: (e) => toast(errorMessage(e), "error"),
  });

  return (
    <div className="pb-24 sm:pb-10">
      <MobileHeader />
      <div className="max-w-[760px] px-4 sm:px-[18px]">
        <h1 className="font-medium text-fg sm:mt-2">settings</h1>

        <Section title="api tokens" hint="one per agent host, e.g. claude-laptop. the action log records which token made each call. revoking one doesn't affect the others.">
          {tokensError ? <p className="text-red">{errorMessage(tokensError)}</p> : null}
          <ul data-testid="token-list">
            {tokens?.map((t) => (
              <li key={t.id} className="flex items-center gap-3 border-b border-line py-2">
                <span className="font-medium text-fg">{t.name}</span>
                <span className="truncate text-muted">
                  created {ago(t.createdAt, now)} · last used {t.lastUsedAt ? ago(t.lastUsedAt, now) : "never"}
                </span>
                <Button variant="danger" size="sm" className="ml-auto" onClick={() => revoke.mutate(t.id)} disabled={revoke.isPending}>
                  revoke
                </Button>
              </li>
            ))}
            {tokens && !tokens.length ? <li className="py-2 text-faint">no tokens yet</li> : null}
          </ul>
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) create.mutate();
            }}
          >
            <input className={inputClass + " max-w-[260px]"} value={name} onChange={(e) => setName(e.target.value)} placeholder="new token name" aria-label="new token name" />
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              create token
            </Button>
          </form>
          {create.error ? <p className="mt-2 text-xs text-red">{errorMessage(create.error)}</p> : null}
        </Section>

        <Section title="dashboard sessions" hint="login links and the login page create a 30-day session cookie.">
          <Button variant="danger" onClick={() => setConfirmLogout(true)}>
            sign out everywhere
          </Button>
        </Section>

        <Section title="storage">
          <dl className="grid grid-cols-[140px_1fr] gap-y-1">
            <dt className="text-faint">action log</dt>
            <dd className="text-fg" data-testid="log-disk">
              {system ? formatBytes(system.logDiskBytes) : "—"} <span className="text-muted">· full screenshots ~7 days, then thumbnails</span>
            </dd>
            <dt className="text-faint">memory</dt>
            <dd className="text-fg">
              {system ? `${formatBytes(system.memoryUsedBytes)} of ${formatBytes(system.memoryBudgetBytes)}` : "—"}
            </dd>
            <dt className="text-faint">desktops</dt>
            <dd className="text-fg">{system ? `${system.running} running · max ${system.maxDesktops}` : "—"}</dd>
          </dl>
        </Section>

        <Section title="about">
          <dl className="grid grid-cols-[140px_1fr] gap-y-1">
            <dt className="text-faint">version</dt>
            <dd className="text-fg">{system?.version ?? "—"}</dd>
            <dt className="text-faint">auth</dt>
            <dd className="text-fg">{system ? (system.auth ? "on" : "off (DESKHAND_AUTH=off)") : "—"}</dd>
          </dl>
        </Section>
      </div>

      <Dialog open={!!created} onOpenChange={(v) => !v && setCreated(null)}>
        <DialogContent title={`token ${created?.token.name ?? ""}`} description="Copy it now; it won't be shown again.">
          <code className="block break-all rounded-sm border border-line-strong bg-bg p-2 text-fg" data-testid="new-token-secret">
            {created?.secret}
          </code>
          <p className="mt-2 text-2xs text-faint">use it as `Authorization: Bearer &lt;token&gt;` in the agent host's MCP config.</p>
          <div className="mt-3 flex justify-end gap-2">
            <Button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(created?.secret ?? "");
                  toast("copied", "ok");
                } catch {
                  toast("couldn't copy; select it manually", "error");
                }
              }}
            >
              copy
            </Button>
            <Button variant="primary" onClick={() => setCreated(null)}>
              done
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmLogout} onOpenChange={setConfirmLogout}>
        <DialogContent title="sign out everywhere?">
          <p className="mb-4 text-muted">Ends every dashboard session, including this one. API tokens keep working.</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmLogout(false)}>
              cancel
            </Button>
            <Button variant="danger" onClick={() => logoutAll.mutate()} disabled={logoutAll.isPending}>
              sign out everywhere
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
