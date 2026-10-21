import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "../components/ui/button";
import { inputClass } from "../components/ui/dialog";
import { api, errorMessage } from "../lib/api";

/** Shown whenever an API call returns 401. Login links (`/auth/login?code=…`) are handled by the manager. */
export function Login() {
  const [token, setToken] = useState("");
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const next = params.get("next");
  const reason = params.get("reason");
  const login = useMutation({
    mutationFn: () => api.login(token.trim()),
    onSuccess: () => {
      qc.clear();
      navigate(next && next.startsWith("/") && !next.startsWith("//") ? next : "/", { replace: true });
    },
  });
  return (
    <div className="grid min-h-dvh place-items-center px-4">
      <div className="w-full max-w-[420px]">
        <div className="mb-6 font-bold text-fg">deskhand</div>
        <h1 className="text-lg text-fg">sign in</h1>
        {reason ? (
          <p className="mt-3 border-l-2 border-amber pl-3 text-amber" role="alert" data-testid="login-reason">
            {reason === "expired"
              ? "That login link has expired or was already used. Links work once, for 5 minutes — get a new one with deskhand login-link."
              : "That login link is incomplete. Copy the whole link that deskhand login-link printed."}
          </p>
        ) : null}
        <p className="mt-2 text-muted">
          On the deskhand host, run <code className="text-fg">deskhand login-link</code> (e.g. <code className="text-dim">docker compose exec deskhand deskhand login-link</code>) and open
          the link it prints. Links work once and expire after 5 minutes.
        </p>
        <p className="mt-4 text-muted">Or paste an API token:</p>
        <form
          className="mt-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (token.trim()) login.mutate();
          }}
        >
          <input
            className={inputClass + " h-10"}
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="dh_…"
            aria-label="api token"
            autoComplete="current-password"
            autoFocus
          />
          {login.error ? <p className="mt-2 text-xs text-red" role="alert">{errorMessage(login.error)}</p> : null}
          <Button type="submit" variant="primary" size="lg" className="mt-3 w-full" disabled={!token.trim() || login.isPending}>
            {login.isPending ? "signing in…" : "sign in"}
          </Button>
        </form>
      </div>
    </div>
  );
}
