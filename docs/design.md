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
  `setns`. **The manager should start desktops with** `SecurityOpt: ["seccomp=<JSON content of that file>",
  "apparmor=unconfined"]` (the Docker API takes the profile's JSON text, the CLI takes a path). The wrapper probes
  `unshare --user` and, if it fails (plain `docker run`), starts Chromium with `--no-sandbox`, logs a warning and
  reports `chromiumSandbox: "off"` in `/state`. Trade-off: `apparmor=unconfined` loosens the container's own
  confinement a little in exchange for Chrome's renderer sandbox; seccomp stays on and no capabilities are added.
- Other container settings the manager should use: `ShmSize` 1 GiB, memory/CPU caps from config. Optional env
  (mainly for tests): `DESKHAND_LOCK_WAIT_MS` (default 30000), `DESKHAND_STUCK_BUTTON_MS` (30000),
  `DESKHAND_LOG_LEVEL` (info).
- Base: Debian trixie slim + Node 24 (copied from `node:24-trixie-slim`); daemon bundled with esbuild to
  `/opt/deskhand/daemon/daemon.mjs`, sharp installed next to it per arch. Apps: Chromium, Firefox ESR, pcmanfm
  (GTK), mousepad (GTK), ristretto (GTK image viewer), FeatherPad (Qt 6), xterm; Noto core/mono/CJK/colour emoji.
  `/etc/deskhand-versions.json` lists versions. ~1.7 GB uncompressed (amd64).
- x11vnc gets `ulimit -n 1024`: under Docker's default nofile limit (~10⁹) it loops over every fd and never
  reaches `accept()`.
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

## Dashboard

- React + Vite + Tailwind + shadcn/ui-style components (Radix), TanStack Query polling, noVNC (`@novnc/novnc`)
  for live view through `GET ${base}/api/desktops/:id/vnc?mode=view|control` (manager proxies to the daemon).
- Visual design follows the prototypes in `docs/prototypes/`: dark, monospace, compact; status dot colours:
  attention = amber, running = green, you have control = violet, stopped = grey, starting = blue.
- Thumbnails: `GET ${base}/api/desktops/:id/thumbnail` (WebP, scaled) refreshed every 1–2 s, not VNC.

## Dev and test

- `scripts/dev` runs Node commands in a container (no Node on the host). Dev images are tagged `:dev`.
- Test containers/resources are labelled `owner=deskhand-dev` and cleaned up by the tests.
- Desktop image: `docker build -f images/desktop/Dockerfile -t deskhand-desktop:dev .` (repo root context;
  `images/desktop/Dockerfile.dockerignore` keeps it small). Daemon unit tests:
  `scripts/dev pnpm --filter @deskhand/daemon test`; desktop e2e: `DEV_DOCKER=1 scripts/dev pnpm --filter
  @deskhand/daemon test:e2e` (starts the image on a throwaway labelled bridge network, talks to the container
  IP, writes the desktop's log to `packages/daemon/test-results/e2e-desktop.log`).

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
