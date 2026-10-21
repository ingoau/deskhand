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
  127.0.0.1:9222, `--force-renderer-accessibility`, stale-profile-lock cleanup, `--disable-dev-shm-usage` is NOT
  used: the container gets `shm_size: 1g`; sandbox on via Chrome's seccomp profile — fall back to
  `--no-sandbox` only if the spike shows the sandbox cannot start, and record it). The panel launcher and the
  daemon's on-demand launch use the same wrapper, so CDP works however Chromium was opened.
- Daemon auth: `Authorization: Bearer <key>` on every route except `GET /health`.

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
  in the one process that already owns the lock.)

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
