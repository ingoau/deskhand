# deskhand — design decisions and contracts

`docs/plan.md` is the product plan. This file records how it is built: who owns what, and the interfaces
between packages. Schemas live in `packages/shared/src` (`daemon.ts`, `manager.ts`, `errors.ts`); this file
explains them. Where this deviates from the plan, it says so.

## Components

```
agent ──MCP /mcp──┐                        ┌── desktop container (deskhand-desktop image)
                  ├─ manager (deskhand) ───┤    entrypoint (root) → supervisord
human ──dashboard─┘   Fastify, SQLite,     │      Xvfb :0 (agent) · openbox + tint2 (agent)
       (static, same   dockerode, MCP,     │      at-spi bus · x11vnc 127.0.0.1:5900 (agent)
        origin)        Playwright MCP      │      daemon :7000 (root) — the only entry point
                                           │      chromium (agent, CDP 127.0.0.1:9222, launched on demand)
                       Docker socket       └── … one per desktop, on network `deskhand-desktops`
```

- The **manager** is the only thing with the Docker socket and the only published port (`127.0.0.1:7480`).
- The **daemon** is the only entry point into a desktop: input, screenshots, lock, exec, files, ui-tree, CDP and
  VNC all go through it, so the lock and the generation counter are enforced in one place.

## Desktop container

- Image `deskhand-desktop:<version>` (dev builds: `deskhand-desktop:dev`). Debian slim, user `agent`
  (UID/GID from `AGENT_UID`/`AGENT_GID`, default 1000).
- Env from the manager: `DESKHAND_DAEMON_KEY` (per-desktop secret), `DESKHAND_SCREEN` (`1280x800`),
  `TZ`, `LANG`. The entrypoint writes the key to `/run/deskhand/key` (root, 0600) and removes it from the
  environment before starting supervisord, so processes running as `agent` never see it.
- The daemon runs as **root** (reads the key, runs `exec` as `agent` via uid/gid, writes files owned by
  `agent`); Xvfb, the WM, VNC and apps run as `agent`.
- Chromium is started through one wrapper, `/usr/local/bin/deskhand-chromium` (remote debugging on
  127.0.0.1:9222, `--force-renderer-accessibility` plus `ACCESSIBILITY_ENABLED=1` — without the env var Chromium
  never joins the AT-SPI bus (spike) —, stale-profile-lock cleanup, `--start-maximized`; `--disable-dev-shm-usage`
  is NOT used: the container gets `shm_size: 1g`). The panel launcher, `chromium` on PATH (symlink),
  `x-www-browser`/xdg-open and the daemon's on-demand launch all use the same wrapper, so CDP works however
  Chromium was opened.
- **Chromium sandbox (spike result):** Chrome's user-namespace sandbox needs `unshare(CLONE_NEWUSER)`, which
  Docker's default seccomp profile blocks, and on AppArmor hosts (Debian 13 here) the `docker-default` AppArmor
  profile blocks it too. The image ships `images/desktop/chrome-seccomp.json` (also at
  `/opt/deskhand/chrome-seccomp.json`): Docker 26's default profile plus one rule allowing `clone`, `unshare`,
  `setns`. **The manager starts desktops with** `SecurityOpt: ["seccomp=<JSON content of that file>",
  "apparmor=unconfined"]` (the Docker API takes the profile's JSON text, the CLI takes a path). As built (phase 2):
  the manager reads the profile at startup (`DESKHAND_SECCOMP_PROFILE`, default `/opt/deskhand/chrome-seccomp.json`
  in the manager image or the repo copy). It adds `apparmor=unconfined` only when `docker info` lists AppArmor.
  `DESKHAND_CHROME_SANDBOX=off` turns both off, and the wrapper then falls back. Verified by the e2e test:
  `/state` says `chromiumSandbox: "on"`, and renderers run in their own user namespace. The wrapper probes
  `unshare --user` and, if it fails (plain `docker run`), starts Chromium with `--no-sandbox`, logs a warning and
  reports `chromiumSandbox: "off"` in `/state`. Trade-off: `apparmor=unconfined` loosens the container's own
  confinement a little in exchange for Chrome's renderer sandbox; seccomp stays on and no capabilities are added.
- Other container settings the manager should use: `ShmSize` 1 GiB, memory/CPU caps from config (per desktop since phase 6, see "Opt-in hardware"). Optional env
  (mainly for tests): `DESKHAND_LOCK_WAIT_MS` (default 30000), `DESKHAND_STUCK_BUTTON_MS` (30000),
  `DESKHAND_LOG_LEVEL` (info).
- Base: Debian trixie slim + Node 24 (copied from `node:24-trixie-slim`); daemon bundled with esbuild to
  `/opt/deskhand/daemon/daemon.mjs`, sharp installed next to it per arch. Apps: Chromium, Firefox ESR, pcmanfm
  (GTK), mousepad (GTK), ristretto (GTK image viewer), FeatherPad (Qt 6), xterm; Noto core/mono/CJK/colour emoji.
  `/etc/deskhand-versions.json` lists versions. ~1.7 GB uncompressed (amd64).
- x11vnc gets `ulimit -n 1024`: under Docker's default nofile limit (~10⁹) it loops over every fd and never
  reaches `accept()`. Phase 2 found that tint2 had the same problem: its forked launcher child closed fds for
  minutes, so clicking a panel launcher did nothing. The entrypoint caps the open-file limit for the whole session
  (since phase 6: soft 1024 / hard 524288, see "Opt-in hardware"); programs that need more raise their soft limit.
- `/run/deskhand` (key, session.env, screen.env) is a **tmpfs** created by the manager (`HostConfig.Tmpfs`, mode
  0755 root; the key file is 0600 root). `docker commit` never captures tmpfs contents, so template images cannot
  contain a desktop's key. The directory stays 0755, not 0700, because agent processes source the env files in it.
- The daemon starts only after the panel is mapped (`session --wait-panel`, up to 15 s). Until then `/health` does
  not answer, so `desktop_start` cannot return a desktop whose first launcher click would be lost (phase 2 finding:
  clicks in the first ~2 s after start went nowhere).
- Daemon auth: `Authorization: Bearer <key>` on every route except `GET /health` (websocket upgrades too).

## Lock, generation, hand-back (owned by the daemon)

- State in daemon memory: `lock` (holder, since, generation), `generation` (int, starts at 1),
  `lastHandback` (note, at, generation).
- `POST /lock` → generation++; releases held buttons. `DELETE /lock {note}` → generation++; records the note.
- Input/exec requests carry the `generation` the caller last saw. When a request reaches the front of the
  per-desktop queue: locked → wait up to 30 s for release, then `locked_by_user`; generation differs from the
  request's → `control_changed` (the caller refreshes and decides again).
- The manager remembers, per MCP session and desktop, the last generation it delivered. If the daemon's
  generation moved and `lastHandback` is newer, the next tool result for that session starts with
  "The user handed control back: <note>" plus a fresh screenshot.
- VNC: the daemon's `/vnc` websocket proxies RFB to x11vnc on localhost and **drops client input messages**
  (KeyEvent, PointerEvent, ClientCutText) unless `mode=control`, the desktop is locked, and the connection's
  generation is current. When the generation changes, control connections from the old generation are closed.
  (Plan said "VNC server starts with input disabled"; filtering in the proxy is the same guarantee, enforced
  in the one process that already owns the lock.) The filter parses the RFB 3.7/3.8 client handshake and every
  client message (incl. extended clipboard, EnableContinuousUpdates, fences, QEMU key/audio, GII,
  SetDesktopSize, xvp); input-like messages are dropped unless allowed, xvp always; anything it cannot frame
  closes the connection. View connections stay open across generation changes; control ones get close code 4001.
- Details as built (phase 1): a request whose `actor` equals the lock holder is not blocked by the lock;
  `POST /lock`/`DELETE /lock` abort the action that is running (it returns `control_changed`) and release held
  buttons/keys (the next result's `notes` say so). `/exec` does the same lock wait and generation check but is
  not queued behind input. `CDP` traffic is not gated by the daemon (it can't see tool boundaries); the manager
  checks `/state` before forwarding `browser_*` calls.

## Daemon input pipeline (phase 1)

- `POST /input`: per-desktop serial queue → lock wait/generation check → deadline (default 10 s, always at least
  the action's own duration + 10 s, so `hold_key`/`wait` up to 300 s work) → XTEST events → settle (screen
  unchanged 300 ms, cap 3 s, `unsettled: true` at the cap) → screenshot (PNG unless `format`) → cursor + notes.
  On timeout or control change everything held is released.
- XTEST through node-x11 (no xdotool per step). `type` binds keysyms without a keycode (non-ASCII, emoji) to
  spare keycodes with `ChangeKeyboardMapping` in batches and restores them afterwards. `key` accepts xdotool names
  and common aliases (Enter, Backspace, ArrowDown, PageDown, cmd/super, ctrl++, space-separated sequences).
- Drag = plan's sequence (hover 50 ms, press, 5 px nudge, 15–25 cubic-eased steps over `duration_ms`, hold
  `hold_ms`, release). `mouse_move` while a button is held is interpolated (≤ 12 px steps) so canvas strokes and
  manual drags get intermediate events. Separate click actions at the same spot within 500 ms are spaced out so
  they don't merge into one multi-click.
- Stuck buttons: released after `DESKHAND_STUCK_BUTTON_MS` without `left_mouse_up`, on lock/unlock, and on
  `POST /release-all` (manager: call on `desktop_stop` and session end); noted in the next result.
- `/exec`: `bash -c` as `agent` with the session env (never the daemon key), stdin closed, own process group;
  returns ~200 ms after the main process exits even if detached children (xclip) hold the pipes; on timeout
  SIGTERM then SIGKILL to the group. 1 MiB cap per stream.
- `/files`: done as `agent` via `cat`/`stat` child processes, so permissions are the agent's (root-only files
  such as the key return `forbidden`) and new files/dirs are owned by `agent`.
- `/ui-tree`: `/opt/deskhand/uitree.py` (pyatspi) as `agent`; prunes non-showing nodes and invalid boxes (closed
  menus report −2³¹); top-level windows carry `app`. GTK icon views don't expose items (pcmanfm needs list view).
- `/quiesce`: `Browser.close` over CDP, `wmctrl -c` every window, SIGTERM/SIGKILL leftover agent processes
  (not the desktop's own), clear `~/.cache`, `~/Downloads`, `/tmp` (keeping X sockets), `/var/tmp` and Chromium
  cache dirs. Paths that are or contain a mount point are skipped, so host mounts are never emptied.
- Logs: JSON lines on stdout (supervisord → `docker logs`), one per action/exec/lock change.

## Shared contract additions (phase 1, additive)

`packages/shared/src/daemon.ts`: `DaemonState.chromiumSandbox?` (`"on"|"off"|null`) and `queueLength?`;
`CursorResponse` (`{x, y, cursor}`); `POST /release-all` → `ReleaseAllResponse` (`{released: string[]}`);
`FilePutResponse`; `QuiesceResponse`; `UiNode.app?`; doc comments on the deadline extension, the lock-holder
actor rule and the CDP URL rewriting (`X-Forwarded-Host/-Prefix/-Proto`).
Phase 3 (additive): `UiNode.description?`, `UiNode.value?`, `UiNode.z?`, window states `active` (X focus only),
`minimized`, `popup`, and `/ui-tree`'s root `stack` (every window, topmost first).

## Playwright MCP notes (spike)

- `createConnection({ browser: { cdpEndpoint: "http://<daemon>/cdp" } })` works through the daemon proxy (send
  the Bearer header, or have the manager's own proxy add it); refs from `browser_snapshot` stay valid across calls.
- Attached to an existing browser, Playwright's "current" tab can be a background tab; clicks then time out
  waiting for "stable". Call `browser_tabs {action: "select", index}` for the visible tab first.
- 0.0.83 element tools take `target` (ref or selector), not `ref` — pin the version.

## Action log (owned by the manager)

- The manager sees every agent and dashboard call, so it writes the log: SQLite row (tool, args, summary,
  outcome, error, actor = token name or `dashboard`, session, duration, overlays) + screenshot files in the data
  volume (`/data/shots/<desktop>/<id>.webp` and `<id>.thumb.webp`). Retention: full for 7 days, then thumbs.
- Outcome `unknown` when the daemon call timed out or the connection dropped mid-action; the agent's next result
  says so and includes a fresh screenshot. Never retried automatically.
- (Plan put `GET /log` on the daemon; the daemon keeps only an in-memory ring of recent actions in `/state`.)

## Manager

- Fastify; dockerode; better-sqlite3 (migrations on start); zod. Data dir `/data` (`deskhand-data` volume).
- Reaches each daemon at `http://<container IP on deskhand-desktops>:7000`, which works both when the manager
  runs in compose and when it runs on a Linux host during development.
- Network `deskhand-desktops`: a bridge created by the manager if missing (label `owner=deskhand`); compose
  attaches the manager to it.
- Container labels: see `packages/shared/src/labels.ts`. Only containers/images with `owner=deskhand` are touched.
- API: see `packages/shared/src/manager.ts`. All routes under `${DESKHAND_BASE_PATH}`; REST under `/api`,
  MCP at `/mcp`, dashboard static files at `/`, health at `/healthz`, auth at `/auth/*`.
- Sessions: each MCP session (Streamable HTTP session id) is a row with its token name and client info.
  Desktops belong to a session (`sessionIndex` 0 = default desktop for that session). Ephemeral desktops are
  removed when the session closes or after `DESKHAND_STOPPED_RETENTION` stopped.
- Idle: no tool calls for `DESKHAND_IDLE_TIMEOUT` → `docker stop` (files kept). Next call → `docker start`, and
  the result opens with a note.

## Templates

- `base` = the desktop image itself (version 1, no commit). Saved versions are images
  `deskhand-template:<name>-v<N>` produced by quiesce + `docker commit` (bind mounts are never in a commit).
- Records (description, manifest, feedback, versions, current-version pointer, default pointer) live in SQLite.

### Templates as built (phase 4)

Code: `packages/manager/src/templates.ts` (records, rules), `template-ops.ts` (save pipeline, rebuild),
`manifest.ts` (probe + classification); MCP tools in `packages/mcp/src/tools.ts`; CLI `deskhand template …`.

- **Save pipeline** (template_save and the dashboard's save-as-template): validate name and description rule →
  start the desktop if stopped → daemon `/quiesce` (Chromium `Browser.close` over CDP, so cookies are flushed;
  other windows closed; caches, Downloads, /tmp cleared; mount points skipped) → manifest probe → `docker commit`
  → prune. Saves of one template are serialised. The repository is `DESKHAND_TEMPLATE_REPO`
  (default `deskhand-template`).
- **Description rule:** a new template needs `description` (summary + use_when). A new version must restate it
  or pass `confirm_description: true` to keep the previous one; otherwise the error quotes the current description.
  An omitted `recipe` keeps the previous version's; `""` removes it. `recipe_file` (a path inside the desktop, read
  before the snapshot) replaces `recipe` so agents don't resend long scripts. `PUT /api/templates/:name/recipe` edits
  the current version's recipe in place (metadata only).
- **Token budget:** every tool result stays in the agent's context and is re-read on each later turn, so MCP output
  is compact. `template_info` lists per-version changes as field names (no before/after text) and the last 5 feedback
  notes, and returns the recipe only with `include_recipe: true`; the REST API still returns the full record.
- **Manifest** (per version): a Python probe (stdlib sqlite3; Python is already in the image) runs in the desktop as
  the agent user via `docker exec` (not the daemon, so a user's takeover lock doesn't block a dashboard save). It
  copies each cookie DB (Chromium `Default|Profile */(Network/)Cookies`, Firefox `cookies.sqlite`) to a temp dir
  and selects only host, name, expiry and flags — **cookie values are never read**. Logged-in sites = registrable
  domains with an unexpired persistent cookie that is not a known tracker/preference cookie and has a login-like
  name or is HttpOnly. Extensions from the Chromium profile's `Extensions/` and Firefox `extensions.json`.
  Packages = installed dpkg packages not in `/etc/deskhand-base-packages.txt` (written at image build).
- **Base version:** `<deskhand.version label>+<image created, UTC>` of `DESKHAND_DESKTOP_IMAGE`, plus its image id.
  Each version records the base it was built on (a desktop started from template X vN inherits X vN's base).
  On start the manager compares the desktop image id with the one recorded last time.
- **Rebuild** (automatic for recipe-backed templates when the base changed, `DESKHAND_TEMPLATE_AUTO_REBUILD`;
  manual via `POST /api/templates/:name/rebuild` / `deskhand template rebuild <name>`), one at a time:
  1. a desktop from the new base (visible in the dashboard as "rebuild template <name>", removed afterwards);
  2. the recipe runs with `bash -e` **as the agent user** with the session env (like desktop_exec), or **as root**
     when one of its first five lines is `# deskhand: run-as=root`; time limit `DESKHAND_RECIPE_TIMEOUT` (20m);
  3. quiesce; then the snapshot's non-scriptable state is copied from the old version's image over the same paths
     (`DESKHAND_TEMPLATE_CARRY`, default `~/.config/chromium`, `~/.mozilla`, `~/.config/mozilla`, `~/.local/share/keyrings`, `~/.pki`:
     browser profiles with cookies, local storage, sessions, saved site data and browser-installed extensions,
     the keyring and the NSS cert store). Paths the old image lacks are left as the recipe made them;
  4. manifest, commit as the next version (same description and recipe, `rebuiltFrom`, saved by
     "deskhand (base update)"). A failure records `rebuild.status = failed` with the recipe's output tail, keeps the
     old version current, flags `outdatedBase`, and is not retried automatically on that base.
  Snapshot-only templates are never rebuilt; they show `outdatedBase` until saved again on the new base.
- **Feedback and stale:** feedback rows carry version, token name and session label. "Last confirmed" = latest `ok`
  for the current version. Stale = latest feedback on the current version is a problem, or neither an `ok` nor the
  version itself is newer than `DESKHAND_TEMPLATE_STALE_AFTER` (14d). `base` is never stale.
  `recentlyChangedByAgent` = a version saved through MCP in the last 24 h (`changedByAgentAt`).
- **Cleanup:** after each save, on desktop removal and at start: keep the newest `DESKHAND_TEMPLATE_VERSIONS`, the
  current one and any version a desktop still uses; an image Docker refuses to remove (still used by a container)
  stays recorded and is retried later.
- **Discovery:** desktop_start's description lists every template (name, summary, use_when, logged-in sites,
  not_for, stale/outdated flags) plus the reuse rule; any template change (save, feedback, rollback, recipe edit,
  rebuild, base change) sends `notifications/tools/list_changed`. desktop_start from a template with logins says
  the session is active and that apps start closed.
- **Known caveat:** `docker commit` includes `/run/deskhand/key` of the saving desktop (root-only, 0600, replaced at
  every start), so a template image holds a dead per-desktop key. Harmless, but don't publish template images.

**Shared contract additions (phase 4, additive/optional):** `TemplateVersion.savedFrom|rebuiltFrom|manifestNotes|
recipe|changes`; `TemplateChanges`/`TemplateListChange`; `TemplateFeedback.session`; `TemplateSummary.staleReason|
changedByAgentAt|hasRecipe|baseVersion|currentBaseVersion|extensions|rebuild`; `SaveTemplateRequest.description` now
optional + `confirm_description`; `RollbackRequest.version` optional; `UpdateRecipeRequest`, `RebuildResponse`.
New routes: `PUT /api/templates/:name/recipe`, `POST /api/templates/:name/rebuild`, `GET /api/templates/:name/diff`.
Runtime interface: `imageInfo`, `exec`, `writeFile`, `copyFromImage`; `removeImage` returns false when in use.

## Dashboard

- React + Vite + Tailwind + shadcn/ui-style components (Radix), TanStack Query polling, noVNC (`@novnc/novnc`)
  for live view through `GET ${base}/api/desktops/:id/vnc?mode=view|control` (manager proxies to the daemon).
- Visual design follows the prototypes in `docs/prototypes/`: dark, monospace, compact; status dot colours:
  attention = amber, running = green, you have control = violet, stopped = grey, starting = blue.
- Thumbnails: `GET ${base}/api/desktops/:id/thumbnail` (WebP, scaled) refreshed every 1–2 s, not VNC.

### Dashboard as built against the real manager (phase 5)

- **Live view:** view mode is noVNC `viewOnly` with pointer events passed through to the page (scroll/pinch the page
  on phones); the daemon drops any input that still arrives (verified in e2e with a raw-RFB client from the page).
  Take over → reconnect with `mode=control&generation=<lock.generation>`; hand back → view mode. A dropped
  connection refetches the desktop (to pick up a new generation) and reconnects with backoff 0.5 s → 10 s, reset on
  connect. "1:1" switches to `clipViewport` + `dragViewport` (drag pans, tap still clicks) without reconnecting.
  Touch in control mode is noVNC's gesture model (tap = click, long press = right click, drag, two-finger scroll).
  Keyboard on phones: the "type into desktop" box, plus "⌨ keyboard", which focuses a hidden textarea and forwards
  each key (a one-character sentinel makes Android backspace visible). Clipboard both ways via noVNC's cut-text
  events, only while in control (the daemon filters ClientCutText otherwise).
- **Takeover UX:** a lock held ≥ 30 min shows "hand back?" on the tile and "agent waiting" on the desktop page; it is
  never released automatically. request_human: amber tile + banner with "times out in" from `attention.timeoutAt`,
  "take over →" from the banner, "dismiss" (`DELETE …/attention`).
- **Action log:** `zoom` stores the full screen as its log screenshot (it stored the zoomed crop before), so every
  overlay is in screen coordinates over a full-screen image (`viewBox = DesktopSummary.screen`); no extra size field
  was needed. `LogEntry.session` is the session label.
- **Fake runtime:** the fake daemon speaks minimal RFB 3.8 (security None, raw frames of the fake screen) and applies
  the same view/control/generation rule, so the dashboard's live view and its e2e suite run without Docker;
  `GET /api/desktops/:id/fake-inputs` exists only with `DESKHAND_RUNTIME=fake`; `DESKHAND_FAKE_LOCK_WAIT_MS`.
- **E2E against the real manager:** `packages/dashboard/playwright.real.config.ts` builds the dashboard and manager,
  starts the manager on a fresh data dir (port 17620 fake / 17621 docker, base `/deskhand`), logs in with login links
  made by the admin credential, and plays the agent with an MCP SDK client. Docker mode labels everything
  `owner=deskhand-dev` with its own instance, network and prefix, and removes desktops, `e2e-*` templates and the
  network in its teardown.

## Dev and test

- `scripts/dev` runs Node commands in a container (no Node on the host). Dev images are tagged `:dev`.
- Test containers/resources are labelled `owner=deskhand-dev` and cleaned up by the tests.
- Desktop image: `docker build -f images/desktop/Dockerfile -t deskhand-desktop:dev .` (repo root context;
  `images/desktop/Dockerfile.dockerignore` keeps it small). Daemon unit tests:
  `scripts/dev pnpm --filter @deskhand/daemon test`; desktop e2e: `DEV_DOCKER=1 scripts/dev pnpm --filter
  @deskhand/daemon test:e2e` (starts the image on a throwaway labelled bridge network, talks to the container
  IP, writes the desktop's log to `packages/daemon/test-results/e2e-desktop.log`).
- Template e2e on the real image: `DEV_DOCKER=1 scripts/dev env DESKHAND_E2E_IMAGE=deskhand-desktop:dev pnpm
  --filter @deskhand/manager test:e2e` (~1 min; runs the test shop from `suite/fixtures/login-site`, logs in with
  real Chromium over CDP, builds a throwaway "new base" image). Test port ranges can be moved with
  `DESKHAND_TEST_PORTS=lo-hi` / `DESKHAND_FAKE_PORTS=lo-hi` on a shared host.

## Computer-use parity (computer_toolset_20260801)

Checked against https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool (2026-10-22):
17 members — `screenshot`, `zoom(region)`, `left_click`/`right_click`/`middle_click`/`double_click`/`triple_click`
(`coordinate?`, `text?` modifiers `shift|ctrl|alt|super` joined by `+`), `left_click_drag(start_coordinate,
coordinate, text?)`, `mouse_move(coordinate)`, `left_mouse_down()`, `left_mouse_up()`, `cursor_position()`,
`scroll(scroll_direction, scroll_amount, coordinate?, text?)`, `type(text)`, `key(text, repeat? 1–100)`,
`hold_key(text, duration ≤ 300 s)`, `wait(duration ≤ 300 s)`.
- `zoom` returns the region captured at full resolution and scaled to fit the usual screenshot dimensions,
  aspect preserved. Coordinates always stay in full-screenshot space.
- `cursor_position` returns text like `X=512, Y=384`.
- Images: the docs name PNG and JPEG; agent-facing results use those (WebP only for dashboard thumbnails).
- deskhand extras beyond the toolset: input tools return a settled screenshot; `left_click_drag` accepts
  `duration_ms`/`hold_ms`.
- `batch(actions, desktop?)` (`packages/mcp/src/batch.ts`, not part of the toolset): runs up to 50 steps, each
  `{action: <input tool>, ...its args}` — pixel tools, `wait`, `desktop_exec`, `browser_*`; not `request_human` or
  `batch` — in one call and returns one screenshot at the end. All steps are parsed with their own tool's schema
  before any runs (no `desktop` per step). Each step runs through its tool's handler with the batch's context, so
  the daemon's lock wait/generation check and settling apply per step; every step gets its own action-log entry
  (the batch itself is not logged). The batch is screen-dependent as a whole and stops at the first step that
  errors, throws `control_changed`, or whose response carries a newer generation (the user took over and handed
  back while it ran): the result lists what ran, the hand-back note, and which steps were not performed.

## Manager and MCP implementation notes (phase 2)

- **Runtimes:** `DockerRuntime` (dockerode) and `FakeRuntime` (in-process fake daemons, `DESKHAND_RUNTIME=fake`, for
  tests and dashboard development). The fake daemon (`packages/manager/src/fake-daemon/fake-daemon.ts`) implements the
  daemon contract with generated PNGs and test hooks under `/_fake/*`.
- **Extra config** beyond the plan's table: `DESKHAND_SESSION_TIMEOUT` (24h; an MCP session idle this long ends and
  its ephemeral desktops are removed — separate from `DESKHAND_IDLE_TIMEOUT`, which only stops desktops),
  `DESKHAND_PUBLIC_URL` (origin for printed links and the origin check), `DESKHAND_SCREENSHOT_MAX_BYTES` (72k) /
  `DESKHAND_SCREENSHOT_QUALITY`, `DESKHAND_REQUEST_HUMAN_TIMEOUT` (10m), `DESKHAND_HELPER_IMAGE` (busybox),
  `DESKHAND_AGENT_UID/GID`, `DESKHAND_DOCKER_SOCKET_PATHS`, `DESKHAND_DASHBOARD_DIR`, `DESKHAND_TRUST_PROXY`,
  `DESKHAND_OWNER_LABEL` / `DESKHAND_INSTANCE` / `DESKHAND_CONTAINER_PREFIX` (test isolation), health/sweep intervals.
- **Generation handling** lives in one wrapper (`packages/mcp/src/registry.ts`): before every desktop tool the manager
  reads `/state`; if the generation moved since the session last saw it and the desktop is unlocked, the result opens
  with the hand-back note plus a fresh screenshot, and screen-dependent input (clicks, typing, keys…) is **not
  performed** that call (the agent's coordinates refer to the old screen). `desktop_exec` still runs. The same applies
  after a restart, a recreation or a lazy start.
- **Host paths** (mount policy and `file_put`/`file_get`) are resolved by a short-lived busybox helper with `/` mounted
  read-only at `/host`, walking symlinks relative to the host root; files are copied through the archive API of a
  created (never started) helper container. The Docker socket and any directory containing it are always refused, as
  are mount targets that would hide the desktop's system directories (`/etc`, `/usr`, `/tmp`, `/home/agent`, …).
- **Sessions survive manager restarts:** a request carrying a known, unexpired session id from the same token is
  resumed without re-initialising. Shutdown never removes desktops.
- **CLI auth:** the manager writes `<data>/admin.json` (`{url, token}`, mode 0600, rotated each start); the CLI uses it
  when run inside the manager container. Agent API tokens cannot manage tokens or login links. Since phase 2 the file
  also has `publicUrl`, the published address, which the CLI uses in printed hints such as `claude mcp add …`.
  In compose, `url` is the in-container `http://127.0.0.1:7480`.

## Packaging, sessions and verification (phase 2, as built)

- **Manager image** `images/deskhand/Dockerfile` (build context = repo root, `Dockerfile.dockerignore` next to it).
  The build stage is `node:24-trixie`, so native modules can compile if no prebuild fits: pnpm install, build the
  manager, MCP server, CLI and dashboard, then reinstall prod-only and copy the workspace layout. pnpm's symlinks are
  relative, so the layout carries over. New dependencies (such as `@playwright/mcp`) need no Dockerfile change. The
  runtime is `node:24-trixie-slim` with `/opt/deskhand/app`, the dashboard at
  `/opt/deskhand/app/packages/dashboard/dist`, Chrome's seccomp profile at `/opt/deskhand/chrome-seccomp.json`, and
  `deskhand` on PATH. About 340 MB.
- **Non-root with the Docker socket:** the entrypoint runs as root only to find the socket's gid (it differs per host),
  chown `/data` and `exec setpriv` to `node` (uid 1000) with that gid as a supplementary group and no capabilities.
  If the socket is not group read/writable, it warns and stays root. `docker compose exec deskhand deskhand …` runs as
  root and reads `/data/admin.json`. HEALTHCHECK: `node /opt/deskhand/healthcheck.mjs` (GET `<base>/healthz`).
- **Listen vs published address:** `DESKHAND_LISTEN` (image default `0.0.0.0:7480`) is where the process listens.
  `DESKHAND_BIND` keeps the plan's meaning, the published host address (compose maps `${DESKHAND_BIND}:7480`), and
  printed links use it unless `DESKHAND_PUBLIC_URL` is set. Without `DESKHAND_LISTEN`, the manager listens on
  `DESKHAND_BIND` (dev and tests).
- **compose.yaml:** project `deskhand` (`DESKHAND_PROJECT`), service `deskhand`, image
  `ghcr.io/ingoau/deskhand:${DESKHAND_VERSION:-latest}`, `restart: unless-stopped`, the socket and `deskhand-data`
  volume (named exactly that; `DESKHAND_DATA_VOLUME`), and network `deskhand-desktops` (named; `DESKHAND_NETWORK`;
  not internal). Compose creates the network and the manager attaches desktops to it. Desktops stay out of compose,
  so `docker compose down` cannot remove a network that still has desktops on it, and desktops keep running across
  upgrades. Every config variable is listed with the plan's default; `TZ`/`LANG` come from the host shell. The
  desktop image defaults to `ghcr.io/ingoau/deskhand-desktop:<DESKHAND_VERSION compiled into the manager>`, so a
  manager pulls the matching desktop. `compose.dev.yaml` builds `deskhand:${DESKHAND_DEV_TAG:-dev}` and
  `deskhand-desktop:…` locally (`--profile build`) and points the manager at the local desktop tag.
- **Session end without DELETE:** Claude Code (2.1.306, `claude -p`) exits without `DELETE /mcp`, so sessions and their
  ephemeral desktops lived until `DESKHAND_SESSION_TIMEOUT` (24h). The MCP service now counts each session's standalone
  SSE stream (`GET /mcp`, which Claude Code and the SDK client open right after `initialize`). A session that had one,
  then has none, with no requests and no tool call running, for `DESKHAND_SESSION_DISCONNECT_GRACE` (default 60s; `0`
  disables) ends as `disconnected`, and its ephemeral desktops are removed. Measured: removed about 66 s after
  `claude -p` exits (grace + one sweep). The grace is well past the SDK client's reconnect backoff. Clients that never
  open the stream still fall back to the 24h timeout. Idle GET streams get an SSE comment (`: keepalive`) every 25 s,
  so reverse proxies don't cut them; a cut stream would look like a disconnect. Claude Code's first request is a
  `server/discover` probe, which gets a 400; it then falls back to `initialize`.
- **Scripted e2e** (`packages/manager/test/e2e/real-desktop.test.ts`, `DEV_DOCKER=1 scripts/dev pnpm --filter
  @deskhand/manager test:e2e`, image `DESKHAND_E2E_IMAGE`, ports 17300–17349) runs against the in-process manager, or
  against a deployment (`DESKHAND_E2E_URL`/`TOKEN`). It covers: the toolset contract on the real server; two concurrent
  sessions with ro/rw mounts (enforcement, host ownership); Chromium opened by one launcher click; the sandbox; the
  tmpfs key dir; removal on session end; cursor/zoom/ui_tree; an RFB handshake through the VNC proxy; and parallel
  actions on two desktops of one session.
- **Reliability suite** (`suite/run.sh`, stdlib Python on the Docker host, real `claude -p` sessions, on demand). It has
  phase 2 tasks in `runner.py` (`contract`, `two_sessions`, `subagents`) and declarative `suite/tasks/*.json` (phase 3/4)
  with JavaScript asserts evaluated in a throwaway `node:24` container. Results with transcripts go to `suite/results/`.
  Resource numbers: `docs/sizing.md` (`suite/measure-resources.py`).

## Beyond pixels implementation notes (phase 3)

**browser_\*** (`packages/mcp/src/browser.ts` generic forwarding + curation, `packages/manager/src/browser.ts` Playwright side)
- `@playwright/mcp` **0.0.83** (pinned exactly, with the `playwright-core` version it uses, `1.64.0-alpha-1790635538000`,
  imported directly). One connection per desktop, created on the first `browser_*` call: playwright-core
  `connectOverCDP("<daemon>/cdp", {headers: Bearer key, noDefaults: true})`, its default context handed to
  `createConnection(config, contextGetter)`, an in-process MCP client over `InMemoryTransport`. Kept for the desktop's
  lifetime (refs stay valid); disposed on the desktop's `stopped`/`removed` events, when its container start time
  changes (restart), on manager shutdown and after a call timeout. Disposal only disconnects: Chromium keeps running
  (checked across a manager restart). If Chromium was closed or crashed, the next call re-attaches (the daemon relaunches
  it) and the result says earlier refs are gone. Calls are serialised per desktop.
- `noDefaults: true` keeps Playwright from overriding download behaviour and emulation on the user's existing pages:
  downloads land in the desktop's `~/Downloads` (tested). `webmcp: false` (page-registered tools would be an injection
  vector). `allowUnrestrictedFileAccess: true` so `file://` pages inside the desktop open; manager-side file access is
  closed separately (below).
- **Foreground tab:** before every call (except `browser_handle_dialog`) the manager evaluates
  `document.visibilityState`/`hasFocus()` in each page (700 ms cap per page) and, if the visible page is not the one it
  last made current, calls `browser_tabs {action:"select", index}`. Page indexes match because Playwright MCP tracks the
  same `BrowserContext`. Tabs opened or switched outside Playwright (the user, pixel `ctrl+1`, `chromium <url>`) are
  followed (e2e).
- **Snapshots:** in 0.0.83 action tools write their page snapshot to a file on the manager and return only a link.
  `snapshot.mode: "none"` turns that off; agents call `browser_snapshot` (returned inline) when they need refs — the
  instructions and descriptions say so. The only rewrite of forwarded results: Playwright's "New console entries:
  <manager file>" line becomes a pointer to `browser_console_messages`.
- **Curated set (19):** navigate, navigate_back, snapshot, find, click, type, fill_form, select_option, hover, drag,
  press_key, handle_dialog, file_upload, wait_for, tabs, evaluate, console_messages, network_requests,
  network_request. Each gets the optional `desktop` argument; `filename` parameters are stripped from every schema (they
  write to the manager's disk) and unknown parameters are refused. `browser_file_upload` `paths` are **desktop** paths:
  the files are read through the daemon (as `agent`) into a per-call temp dir on the manager. Every upstream tool must
  be curated or listed in `BROWSER_EXCLUDED` with a reason; the contract test
  (`packages/manager/test/browser-contract.test.ts`, snapshot `test/__contract__/browser-tools.json`) fails otherwise.
- **Excluded:** `browser_close` (closes the shared browser the user watches), `browser_resize` (window is maximised to
  the desktop), `browser_take_screenshot` (duplicates screenshot/zoom; writes files on the manager), `browser_install`,
  `browser_run_code_unsafe` (arbitrary JS **in the manager process**, which holds the Docker socket), `browser_emulate_media`
  (changes the user's view), `browser_drop` (paths on the manager's disk), `browser_pdf_save` (writes on the manager).
  Optional capabilities (vision/xy, storage/cookies, network routes, tracing/video, devtools, testing) are not enabled.
- **Through ToolRegistry:** `scope: "desktop"`, `input: true`; element-acting tools (click, type, fill_form,
  select_option, hover, drag, press_key) are `screenDependent`, so after a change of control they are not performed and
  the hand-back note plus a screenshot come back instead; navigation, tabs, snapshot, evaluate still run (with the
  note). Because the daemon does not gate CDP, the handler polls `/state`: while locked it waits up to
  `DESKHAND_LOCK_WAIT` (default 30 s, like the daemon's input wait) and then fails `locked_by_user`; if the generation
  moved meanwhile it fails `control_changed` (same handling as pixel input). A call that times out (90 s) or whose
  connection breaks is `outcome_unknown` if it can act (`timeout` for read-only tools). Every call is logged with a
  summary (`browser_type "Email" ← "a@b.c" ⏎`); action tools store a screenshot with the entry. Gap: a takeover that
  starts while a browser call is already running does not interrupt it (the window is that call's duration).
- Config: `DESKHAND_BROWSER_TOOLS` (default on), `DESKHAND_LOCK_WAIT` (30s). Playwright's output dir is
  `<data>/playwright/<desktop>`.

**ui_tree** (`packages/daemon/helpers/uitree.py`, formatting in `packages/mcp/src/uitree.ts`)
- The helper matches AT-SPI windows to X windows (`wmctrl -lp`, `_NET_CLIENT_LIST_STACKING`, `_NET_ACTIVE_WINDOW`; by
  pid+title, then title, then pid): windows come topmost first with `z`; only the window with the X focus is `active`
  (AT-SPI's own flag goes stale); minimised windows are marked and not walked; unknown override-redirect windows are
  `popup`; unnamed empty frames (Chromium's hidden omnibox popups) are dropped. Elements get `value` (Text/Value
  interfaces: editable text, entries, sliders; 300 chars) and `description` when unnamed (Qt tooltips such as
  "Next (F3)"); text duplicating its parent's name is dropped. Budgets: 2500 nodes per window, 4000 total (all to the
  filtered window). `window` matches title **or app name**. Root `stack` lists every window (also filtered-out ones).
- MCP output, one line per element: `button "Save" [disabled] @87,63 box=[71,48,32,31]`. `@x,y` is the centre of the
  element's part that is on screen, inside its window and not covered by a window above it (from `stack`, so filtered
  output is right too); if none, the line says "covered by window …; raise this window first" or "outside the visible
  area". Unnamed layout wrappers are hoisted, toolbars/menus/lists/documents stay as headings. Capped at 24 000
  characters with a note naming the windows to filter by. Chromium exposes only on-screen page elements as showing, so
  page trees stay small; for web pages `browser_snapshot` is the better channel. ~0.3 s on three apps.
- Verified on Chromium (form page: entries with values, radio buttons, checkbox, button), mousepad and pcmanfm (GTK 3)
  and FeatherPad (Qt 6) — e2e and real agent runs.

**desktop_exec** unchanged; verified: launches GTK/Qt apps with `&`, returns ~250 ms after `xclip` forks, a 2 s
timeout kills the process group (no orphans), runs as `agent` (uid 1000) in the container (no daemon key, no Docker
socket), cwd `~`.

**Test pages:** `testpages/form.html` (contact form: text, email, select, radio, checkbox, textarea) submits by GET to
`form-done.html`, which shows the values and keeps them in `window.deskhand.result` and localStorage; tests read the
submitted values from Chromium's page URL inside the desktop (`curl 127.0.0.1:9222/json/list` via exec).

**Tests:** `packages/mcp/test/uitree.test.ts` (formatter, real captured fixture), `packages/manager/test/takeover.test.ts`
(three channels × lock/hand-back/generation, logging, unknown outcome; fake browser provider via
`ManagerDeps.browser`), `browser-contract.test.ts`, and `test:e2e` (`packages/manager/test/e2e/phase3.e2e.test.ts`,
real image: `DEV_DOCKER=1 scripts/dev env DESKHAND_E2E_IMAGE=deskhand-desktop:dev pnpm --filter @deskhand/manager
test:e2e`). Test ports are configurable: `DESKHAND_TEST_PORTS=17400-17449 DESKHAND_FAKE_PORTS=17450-17499`.
Reliability suite tasks: `suite/tasks/web-form.json`, `suite/tasks/native-edit-uitree.json`.

## Opt-in hardware: per-desktop memory/CPUs and KVM (phase 6)

Code: `packages/manager/src/hardware.ts` (bounds, precedence, KVM detection), `desktops.ts` (admission, records),
`runtime/docker.ts` (`Devices`, limits), the desktop entrypoint (device permissions). Goal: make heavy
workloads such as the Android emulator possible and discoverable without baking any toolchain into the image
(`docs/android.md` has the findings of a real agent run).

- **Arguments:** `desktop_start(memory?: "8g", cpus?: 4, kvm?: true)`, `POST /api/desktops {memory, cpus, kvm}`
  (`memory` also accepts bytes as a number), `deskhand start --memory 8g --cpus 4 --kvm`. Bounds:
  `DESKHAND_DESKTOP_MAX_MEMORY` (default 8g) and `DESKHAND_DESKTOP_MAX_CPUS` (default 4, and never more than the
  Docker host's CPUs); minimum 512m / 0.25. Over the max → `invalid_argument` whose message states the limit. The
  defaults stay `DESKHAND_DESKTOP_MEMORY` / `DESKHAND_DESKTOP_CPUS`; the max may not be below them.
- **Precedence:** explicit argument > the desktop's own hardware (recreation after retention) > the template
  version's recorded hardware > the defaults. Template values over the current max are capped and the agent is
  told so; explicit values over the max are an error.
- **Admission** budgets each active desktop's own memory cap (`sum(active caps) + new cap <= budget`); restarts are
  admitted by the desktop's own cap. Hardware is stored per desktop (`desktops.memory_bytes|cpus|kvm`, migration 3)
  and read back from `HostConfig` when a container is imported by label, so restarts, unhealthy restarts and
  recreations keep it.
- **KVM:** `DESKHAND_KVM=auto|off` (default auto). Availability is checked **on the Docker host**: the runtime starts
  the helper image (busybox) with the host's `/dev` bind-mounted read-only and tests `[ -c /hostdev/kvm ]` (the
  manager itself may run in a container that cannot see the host's devices; a bind of `/dev/kvm` itself is avoided
  because Docker would create a missing bind source as a directory). Cached 10 min; errors are not cached; done
  once at startup (bounded to 15 s) so descriptions can state it. `kvm: true` when unavailable or off →
  `kvm_unavailable` (new error code, HTTP 409) saying which. When granted, the container gets
  `HostConfig.Devices = [{/dev/kvm → /dev/kvm, rwm}]` and nothing else changes (no capabilities, no privileged).
- **Making /dev/kvm usable by `agent` — approach and why:** the entrypoint (root) runs
  `chgrp $AGENT_GID /dev/kvm && chmod 0660 /dev/kvm` when the device is present. That node lives in the container's
  own `/dev` (a per-container tmpfs that runc populates), so the host's `/dev/kvm` keeps `root:kvm 0660` (checked in
  the e2e). The agent's **primary** group is used, not a supplementary `kvm` group, because not every process
  start path keeps supplementary groups: the daemon runs `desktop_exec` through Node's `spawn({uid, gid})`, and
  libuv calls `setgroups(0)` when it sets a uid, so supplementary groups never reach exec'd commands; `docker exec
  --user uid:gid` (manifest probe, recipes) has none either. Every path keeps the primary gid: supervisord programs
  (`user=agent`), the panel (tint2 → `sh` → app), terminals, `desktop_exec`, `docker exec`. Re-applied on every
  container start (runc recreates the node). Verified: `desktop_exec` and an xterm started from the panel (pixel click;
  ancestry xterm → sh → tint2) both open `/dev/kvm` O_RDWR and `KVM_GET_API_VERSION` returns 12.
- **Templates remember hardware:** a save records `TemplateHardware {kvm, memoryBytes|null, cpus|null}` from the
  desktop (memory/cpus null when they were the defaults, so such templates follow later default changes; nothing is
  stored when all are defaults). A rebuild runs the recipe on a desktop with the template's memory/CPUs (KVM only if
  available) and keeps the recorded hardware. A template recording `kvm` on a host without KVM → `kvm_unavailable`
  that says `kvm: false` starts it anyway.
- **Discoverability:** desktop_start's description and the MCP `instructions` say: for workloads like the Android
  emulator or other VMs, start with `kvm: true` and more memory/CPUs (current max and KVM state stated), no root —
  install user-space toolchains into the home directory, then `template_save` (which records the hardware). The
  template listing shows `starts with kvm, 8g memory, 4 CPUs`; `template_list` has `hardware`.
- **Dashboard:** "+ new" has memory / cpus inputs (placeholders = template or host default, hints = max) and a kvm
  switch (disabled with the reason when unavailable/off); tiles and the detail meta line show `kvm` and the memory cap
  when it differs from the default (CPU cap on the detail line and the tile tooltip); template pages show hardware.
- **Long commands:** `desktop_exec` sends an MCP progress notification every 20 s while its command runs (found in the
  real-agent Android run: Claude Code aborts a call that is silent for 300 s, which cut off an SDK install).
- **Desktop open-file limit (found while verifying the panel path):** under Docker's default `nofile` (~10⁹ soft and
  hard) tint2's launchers fork a child that loops closing every possible fd before `exec`, so a panel click left a
  100 %-CPU `tint2` child and no app for minutes. The entrypoint now sets soft 1024 / hard 524288 (systemd's login
  defaults) before supervisord; programs needing more raise their soft limit themselves.

**Shared contract additions (phase 6, additive/optional):** error code `kvm_unavailable`; `DesktopHardware`,
`TemplateHardware`, `HardwareInfo`; `DesktopSummary.hardware?`, `CreateDesktopRequest.memory?|cpus?|kvm?`,
`SystemSummary.hardware?`, `TemplateVersion.hardware?`, `TemplateSummary.hardware?`. Runtime interface:
`kvmAvailable()`, `DesktopSpec.kvm?`, `ContainerInfo.memoryBytes?|cpus?|kvm?`. MCP backend: `hardware?()`,
`StartOptions.memory|cpus|kvm`, `DesktopRef.hardware?`; `agentInstructions(hw)` (AGENT_INSTRUCTIONS stays).

**Tests:** `packages/manager/test/hardware.test.ts` (fake runtime: bounds, admission with per-desktop memory, restart
/recreation/manager-restart/import keep hardware, KVM available/unavailable/off and caching, template defaults,
overrides and capping), `cli.test.ts` (`start --memory --cpus --kvm`), dashboard unit + mock e2e (new-desktop dialog,
markers), and the real-image e2e `packages/manager/test/e2e/hardware.e2e.test.ts`:
`DEV_DOCKER=1 scripts/dev env DESKHAND_E2E_IMAGE=deskhand-desktop:dev-kvm pnpm --filter @deskhand/manager exec vitest
run test/e2e/hardware.e2e.test.ts`. Reliability suite: `suite/tasks/android-emulator.json` (slow, expensive).

## Install, upgrades and remote access (phase 6)

User docs: `docs/quickstart.md`, `docs/remote-access.md`, `docs/configuration.md`, `docs/security.md`.

- **Upgrades: desktops switch images when they next start (decision).** The plan says each desktop "switches to the
  new desktop image at its next restart", but `docker start` reuses a container's image, so phase 2 desktops never
  switched. `DesktopService.ensureRunning` now calls `recreateOnCurrentImage` first. It resolves the desktop's
  template version to an image: for `base` that is `DESKHAND_DESKTOP_IMAGE`, which changes with the manager's
  version or with a `docker compose pull` of the same tag. It compares that image's id with the container's
  `imageId`. If they differ, it:
  1. renames the old container to `<name>-replaced-<rand>`;
  2. creates a new one with the same id, name, labels, env (daemon key), mounts and per-desktop hardware;
  3. copies `/home/agent` across with the archive API. The tar stream is filtered: mount points under the home and
     `~/.cache` are skipped, so host files are never copied into a container layer or written back through a bind;
  4. starts it, waits for health, and only then removes the old container.

  Any failure removes the new container, renames the old one back and starts it as before; the desktop never loses
  its files. The agent's next result says the desktop now runs the new image and that `/home/agent` was kept.
  Rationale for copying the home rather than keeping it in a named volume: a volume would be invisible to
  `docker commit`, which breaks save-as-template for exactly those desktops. The agent can only write its home and
  temp directories anyway (no root, no package installs outside recipes), so the home is the state worth keeping.
  Running desktops are never touched, and neither are desktops from saved template versions: those are their own
  images, rebuilt by the recipe mechanism (phase 4). A manager that dies mid-recreation is cleaned up on the next
  start (`resolveParked`): the parked container goes if its replacement got as far as starting (files are copied
  before the start), otherwise the replacement goes and the parked one is renamed back. Runtime additions:
  `ContainerInfo.imageId?`, `rename()`, `copyDir()` (Docker and fake). Verified for real: a compose deployment,
  a file in `~/Documents` of a stopped persistent desktop, a new desktop and manager image under the same tags,
  `docker compose up -d`. A second desktop kept running on the old image; `deskhand start` brought the stopped one
  up on the new image id in 11 s, with the file intact and owned by `agent`, and `~/.cache` gone.
- **Desktop image pre-pull:** if `DESKHAND_DESKTOP_IMAGE` isn't present at startup (first install, new version tag),
  the manager pulls it in the background, then re-runs `templates.initBase()` and auto-rebuild. Otherwise a new
  user's first `desktop_start` would wait for about 0.7 GB.
- **Quickstart timing** (2026-10-22, images present locally, retagged to GHCR names because the GHCR packages are
  private; a fresh compose project with its own port, network, volume and instance): `docker compose up -d` returned
  in 0.9 s, the login link and token were in the logs at 2.9 s, `claude mcp add` (into a scratch
  `CLAUDE_CONFIG_DIR`) finished at 3.4 s, `desktop_start` returned at 12.2 s, and the agent's first `left_click` on
  the terminal launcher came at **15.2 s**. An xterm was then open in the desktop (`wmctrl -l`). Claude Code
  2.1.306, `claude-sonnet-5-5`, 4 turns. The one-time download is about 0.9 GB compressed (gzip of
  `docker save`: desktop 729 MB, manager 129 MB).
- **Sub-path and proxies:** nothing needed changing for `DESKHAND_BASE_PATH` behind a prefix-keeping proxy. Verified
  with Caddy (TLS internal CA and plain HTTP), Tailscale Serve (`--set-path`), an SSH tunnel and Playwright through
  Caddy: grid polling, noVNC live view over `wss://…/deskhand/…/vnc`, take over, typing, hand back. Real Claude Code
  sessions clicked in a desktop through each (details in `docs/remote-access.md`). Observed: Tailscale Serve
  forwards the scheme, so cookies are `Secure`. A cookie-authenticated write or websocket without an `Origin` is
  refused (403). An MCP `DELETE` that carries `content-type: application/json` with no body gets Fastify's 400;
  real clients don't send that header on DELETE.
- **Chromium sandbox warning:** on Ubuntu 23.10+ `kernel.apparmor_restrict_unprivileged_userns=1` blocks Chromium's
  user-namespace sandbox regardless of seccomp/AppArmor options (found by CI on ubuntu-24.04). The manager reads
  that sysctl at startup (kernel.* is not namespaced, so it can read it from inside its container) and warns. It
  also warns once when a running desktop's `/state` says `chromiumSandbox: "off"` while `DESKHAND_CHROME_SANDBOX`
  is on. `SystemSummary.warnings?: string[]` (additive) carries the message to the dashboard's settings page
  ("host warnings"). The fake daemon accepts `behavior.chromiumSandbox` for the test.
- **License texts:** the desktop image no longer deletes `/usr/share/doc/*/copyright`. The slim base's dpkg config
  already drops the rest, so all 426 installed packages keep their copyright file (checked). Bundled npm code
  ships without `node_modules`, so `scripts/third-party-licenses.mjs` collects the license files of a package's
  production dependency tree at build time: `/opt/deskhand/daemon/THIRD-PARTY-LICENSES.txt` and
  `packages/dashboard/dist/THIRD-PARTY-LICENSES.txt` (served at `<base>/THIRD-PARTY-LICENSES.txt`). Both images
  carry `LICENSE` and `NOTICE` in `/usr/share/doc/deskhand/`.
- **CLI wrapper:** `scripts/deskhand` runs `docker exec` into the container labelled
  `com.docker.compose.project=$DESKHAND_PROJECT` (default `deskhand`) and `service=deskhand`. It needs no compose file
  and allocates a TTY only when stdin and stdout are terminals, so `deskhand screenshot > shot.png` stays binary-clean.
- **arm64:** not built locally (no binfmt/QEMU registered on the dev host; CI builds and publishes both
  architectures).
