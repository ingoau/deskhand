# Manager API used by the dashboard

Every route the dashboard calls, with the request and response shapes it expects. Types in `Code` are
from `packages/shared/src/manager.ts` / `daemon.ts`; routes marked **new** are not in the shared contract
yet and need adding in the manager (and, where useful, as zod schemas in `packages/shared`). The mock in
`mock/plugin.ts` implements all of them and is the reference behaviour.

All paths are relative to `${DESKHAND_BASE_PATH}/` (the dashboard never uses absolute paths).
Auth is the session cookie; any `401` sends the dashboard to its login page. Errors use `ErrorBody`
(`{ error: { code, message, details? } }`) with the status from `ERROR_STATUS`; the dashboard shows
`error.message` to the user.

## Serving the dashboard

- Static files from `packages/dashboard/dist` under the base path. Assets are referenced relatively
  (`./assets/…`), so they work under any sub-path.
- For any GET under the base that is not `api/`, `auth/`, `mcp`, `healthz` or an existing file, serve
  `index.html` (SPA fallback; routes are `/`, `/desktops/:id`, `/desktops/:id/log`, `/templates`,
  `/templates/:name`, `/settings`, `/login`).
- When serving `index.html`, replace `<base href="/" />` with `<base href="${DESKHAND_BASE_PATH}/" />`
  (e.g. `<base href="/deskhand/" />`). Optionally also inject `<script>window.__DESKHAND_BASE__="/deskhand/"</script>`;
  the dashboard prefers it over `<base>` if present. Send `Cache-Control: no-cache` for `index.html`;
  `assets/*` are content-hashed and can be cached immutably.
- `GET ${base}` without the trailing slash should redirect to `${base}/`.

## Desktops

| Method & path | Request | Response | Notes |
|---|---|---|---|
| `GET api/desktops` | — | `{ desktops: DesktopSummary[] }` | Polled every 2 s. |
| `GET api/desktops/:id` | — | `DesktopSummary` | Polled every 1.5 s on the detail page. `404 desktop_not_found` when gone. |
| `POST api/desktops` | `CreateDesktopRequest` (`{ template?, name?, persistent? }`) | `201 DesktopSummary` (status `starting`) | "+ new" and template "edit" (`name: "edit-<template>"`). `429 limit_reached`, `404 template_not_found`. |
| `DELETE api/desktops/:id` | — | `204` | Kill. |
| `POST api/desktops/:id/stop` **new** | — | `DesktopSummary` | `docker stop`, files kept; releases the lock and clears attention. |
| `POST api/desktops/:id/start` **new** | — | `DesktopSummary` | Start a stopped desktop (status `starting`). |
| `POST api/desktops/:id/persistent` **new** | `{ persistent: boolean }` | `DesktopSummary` | "mark persistent" toggle. |
| `POST api/desktops/:id/lock` **new route** | `{}` | `LockResponse` = `{ generation, lock: Lock }` | Take over. Holder is `"dashboard"`. Proxies daemon `POST /lock`. `409 desktop_stopped` if not running. Idempotent if already locked. |
| `DELETE api/desktops/:id/lock` **new route** | `{ note: string \| null }` (`UnlockRequest`) | `LockResponse` = `{ generation, lock: null }` | Hand back with optional note. The manager should also clear `attention` (the request_human call returns with the note). |
| `DELETE api/desktops/:id/attention` | `{ note: string \| null }` | `DesktopSummary` | "dismiss" on the needs-you panel: clears a request_human flag without taking over; the agent's request_human returns "dismissed". |
| `POST api/desktops/:id/save-as-template` **new** | `{ name: string, description: TemplateDescription }` | `{ template: TemplateSummary, version: number }` | Quiesce + commit; can take several seconds. Name `^[a-z0-9][a-z0-9-]*$`; an existing name adds a version. `400 invalid_argument` with a readable message on bad input. |
| `POST api/desktops/:id/files` **new** | `multipart/form-data`: `path` (absolute, default `/home/agent/Downloads/<file name>`), `file` | `{ path: string, bytes: number }` | Upload; file owned by `agent`. |
| `GET api/desktops/:id/files?path=/abs/path` **new** | — | raw bytes, `Content-Disposition: attachment; filename="<basename>"` | Download, opened as a plain link (cookie auth). |
| `GET api/desktops/:id/thumbnail` | `?t=<ms>` cache-buster | image (WebP; any `image/*` works) | Refreshed every 1.5 s per visible running tile. Should be cheap (scaled screenshot, ~320 px wide). Send `Cache-Control: no-store`. |
| `GET api/desktops/:id/vnc` (websocket) | `?mode=view` or `?mode=control&generation=N` | raw RFB over binary websocket | noVNC client. View-only by default; after takeover `generation` is the one from `LockResponse` (or `DesktopSummary.lock.generation` after a reload). The daemon drops input unless control + locked + current generation and closes stale control connections; the dashboard reconnects with backoff. No VNC password is sent. Same-origin check applies. |

`DesktopSummary` fields the UI relies on: `title` (null → shown as "untitled"), `name`, `session`,
`template`, `templateVersion`, `status`, `persistent`, `attention` (`reason`, `since`, `timeoutAt` →
"needs you · 2m", "agent blocked · times out in 8m"), `lock` (`since` → "you have control · 34m"),
`generation`, `lastHandback`, `lastAction.summary` (second line of a tile), `createdAt` (sort order and
the m:ss counter while starting), `startedAt` (uptime), `stoppedAt` + `lastActivityAt` ("stopped · idle
30m", run time of a stopped desktop), `screen` (live view aspect ratio, "1280×800" label, overlay
coordinate space), `cpuPercent`, `memoryBytes`.

## Action log

| Method & path | Request | Response | Notes |
|---|---|---|---|
| `GET api/desktops/:id/log?before=<id>&limit=<n>` | — | `{ entries: LogEntry[] }` newest first | Detail page polls `limit=5` every 4 s; log page pages with `limit=30` and `before=<last id>`. |
| `GET api/log/:id/screenshot` | `?thumb=1` for the thumbnail | image | Shown with `overlays` drawn on top in screen coordinates (`DesktopSummary.screen`), so the stored screenshot must be the full screen (thumbnail = same framing, scaled). |

Overlay semantics used for drawing: `point.at` = click position; `path.points` = drag path, arrow at the
last point; `region.region` = `[x0, y0, x1, y1]` (zoom region, any corner order).

## Templates

| Method & path | Request | Response | Notes |
|---|---|---|---|
| `GET api/templates` | — | `{ templates: TemplateSummary[] }` | Polled every 15 s; any `recentlyChangedByAgent` puts the amber dot on the "templates" nav. |
| `GET api/templates/:name` | — | `TemplateDetail` | `versions` in any order (sorted client-side); diffs between consecutive versions are computed client-side from `description`, `loggedInSites`, `extensions`, `packages`, `baseVersion`, `hasRecipe`. |
| `POST api/templates/:name/rollback` **new route** | `{ version: number }` | `TemplateDetail` | Repoint the name at that version (also used to restore a newer version after a rollback). `currentVersion < latestVersion` is shown as "rolled back · latest vN". |
| `POST api/templates/:name/default` **new** | — | `TemplateDetail` | Make this the default template. |
| `DELETE api/templates/:name` **new route** | — | `204` | The UI disables delete for the default template; the manager should refuse deleting `base` / the default with a readable `ErrorBody`. |

## Tokens, auth, system

| Method & path | Request | Response | Notes |
|---|---|---|---|
| `GET api/system` | — | `SystemSummary` | Header `6/8 · 46% · 9.8G` = `running/maxDesktops · cpuPercent · memoryUsedBytes`; settings show `logDiskBytes`, `memoryBudgetBytes`, `version`, `auth`. Polled every 5 s. |
| `GET api/tokens` **new route** | — | `{ tokens: ApiToken[] }` | |
| `POST api/tokens` **new route** | `{ name: string }` | `201 { token: ApiToken, secret: string }` | The secret is shown once. |
| `DELETE api/tokens/:id` **new route** | — | `204` | |
| `POST auth/login` | `{ token: string }` | `204` + `Set-Cookie` session (HttpOnly, SameSite=Strict, Path=base) | Login page with an API token. `401 unauthorized` with a readable message for a bad token. |
| `GET auth/login?code=…` | — | `302` to `${base}/` + `Set-Cookie` | Login links; handled entirely server-side. |
| `POST auth/logout-all` | — | `204` | "Sign out everywhere"; the dashboard then shows its login page. |

## As wired against the real manager (phase 5)

The dashboard now runs against `packages/manager` end to end (`e2e-real/`, see below). Where the manager differs
from the tables above, the manager wins and the mock mirrors it:

- `POST api/desktops` answers `201` while the desktop is still `starting`.
- Anything that needs a running desktop (lock, files, screenshots) answers `409 desktop_stopped` when it isn't.
- A dead login link (`GET auth/login?code=…`) redirects to `${base}/?login=expired` (`missing` without a code): the
  login page explains it, or — already signed in — a toast says the session is still valid.
- Templates (phase 4): `PUT api/templates/:name/recipe {recipe}` (recipe editor), `POST api/templates/:name/rebuild`
  (rebuild button; waits for the new version), save-as-template takes `confirm_description: true` instead of a
  description for a new version ("keep the current description") and returns `notes`; `TemplateVersion.changes` is
  preferred over the client-side diff. `GET api/templates/:name/diff` exists but the page doesn't need it.
- `LogEntry.session` is the session label (`token/abcd`), like `DesktopSummary.session`.
- Fake runtime only: `GET api/desktops/:id/fake-inputs` (what reached a fake desktop, incl. VNC input that got
  through the filter) for the e2e suite.

Tests: `pnpm e2e` (mock), `pnpm e2e:real` (real manager, `DESKHAND_RUNTIME=fake`), `pnpm e2e:docker` (real manager +
`deskhand-desktop:dev` desktops, needs `DEV_DOCKER=1`); `SCREENSHOTS=1 pnpm e2e:docker screenshots` refreshes
`screenshots/real/`. Run them in the Playwright image:
`DEV_DOCKER=1 DEV_IMAGE=mcr.microsoft.com/playwright:v1.64.1-noble scripts/dev pnpm --filter @deskhand/dashboard e2e:docker`.

## Suggested additions to `packages/shared`

Not added (to avoid editing the shared package); the dashboard defines these locally in `src/lib/api.ts`:

```ts
export const ListDesktopsResponse = z.object({ desktops: z.array(DesktopSummary) });
export const LogResponse = z.object({ entries: z.array(LogEntry) });
export const ListTemplatesResponse = z.object({ templates: z.array(TemplateSummary) });
export const SetPersistentRequest = z.object({ persistent: z.boolean() });
export const SaveAsTemplateRequest = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), description: TemplateDescription });
export const SaveAsTemplateResponse = z.object({ template: TemplateSummary, version: z.number().int() });
export const RollbackRequest = z.object({ version: z.number().int() });
export const UploadResponse = z.object({ path: z.string(), bytes: z.number().int() });
export const CreateTokenRequest = z.object({ name: z.string().min(1) });
export const CreateTokenResponse = z.object({ token: ApiToken, secret: z.string() });
export const LoginRequest = z.object({ token: z.string().min(1) });
// lock routes reuse LockRequest/UnlockRequest/LockResponse from daemon.ts
```
