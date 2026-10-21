# Spike findings (2026-10-22)

Scratch setup: a `debian:trixie-slim` image with Xvfb 1280x800x24, openbox, tint2, Chromium 155, Firefox ESR,
mousepad (GTK 3), FeatherPad (Qt 6), at-spi2-core, python3-pyatspi and Node 24, on Docker 26.1.5 / Debian 13
(kernel 6.12, AppArmor on). Throwaway code lived in `/tmp/deskhand-spike-*`; it has been deleted.

| Check | Result | Decision |
| --- | --- | --- |
| Input and capture (`x11` npm package) | **Pass** | Use `x11` (node-x11 4.3.1) for XTEST input and GetImage capture |
| Screenshot size | **Pass** | PNG by default for agents; JPEG as an option; WebP for dashboard thumbnails |
| Accessibility tree (pyatspi) | **Pass** (Chromium needs `ACCESSIBILITY_ENABLED=1`) | Bundle the pyatspi helper; set the env in the Chromium wrapper |
| Browser tools (`@playwright/mcp` over a CDP proxy) | **Pass**, with a foreground-tab caveat | Use `createConnection({browser:{cdpEndpoint}})` through the daemon proxy |

## 1. Input and capture: pass

- `X.require("xtest")` → `FakeInput(MotionNotify | ButtonPress | ButtonRelease | KeyPress | KeyRelease, …)`.
  Moving to (300,200) put the pointer there (`QueryPointer` and `xdotool getmouselocation` agree).
- Typing: each character's keysym is looked up in `GetKeyboardMapping`. Characters with no keycode (`Ü`, `日本語`,
  `😀`) are typed by temporarily writing the keysym (`0x01000000 | codepoint`) to one of the 19 spare keycodes with
  `ChangeKeyboardMapping`, pressing it, then clearing it. Typed into mousepad, then ctrl+a / ctrl+c via XTEST,
  `xclip -o` returned exactly `Hello World! Ünïcødé 日本語 😀 ~|{}`.
- Capture: `GetImage(ZPixmap, root, 0,0,1280,800)` took **5 ms** (4 096 000 bytes BGRX); sharp channel swap and PNG
  encode took 28–110 ms.
- No fallback needed (no xdotool per step, no native helper).

## 2. Screenshot size: pass

Full-screen 1280x800 screenshots of busy pages, captured with node-x11 and encoded with sharp (KB of base64):

| Page | PNG | PNG palette | WebP q80 | WebP lossless | JPEG q80 | JPEG q60 |
| --- | --- | --- | --- | --- | --- | --- |
| en.wikipedia.org main page | 321 | 126 | 126 | 221 | 207 | 153 |
| news.ycombinator.com | 152 | 81 | 87 | 62 | 150 | 110 |
| bbc.com/news (photos) | 387 | 106 | 57 | 179 | 105 | 78 |
| github.com/microsoft/playwright | 168 | 83 | 95 | 84 | 173 | 128 |

How Claude Code counts it (read from the 2.1.306 bundle): the limit is `MAX_MCP_OUTPUT_TOKENS` (default 25 000).
Each image block counts as a **flat 1 600 tokens** in the first estimate; only if the estimate exceeds half the
limit does it ask the token-counting API, and only above the limit does it shrink or drop images. The base64 size
is not what's counted; the API's image token cost is roughly `w*h/750` ≈ 1 365 tokens for 1280x800 and ≈ 2 765
for 1920x1080. So one full screenshot is far inside the limit in any format.

Live check: a throwaway Streamable-HTTP MCP server (Node, `@modelcontextprotocol/sdk`, port 17042) returned the
bbc.com PNG (396 392 base64 chars, the largest above). `claude -p … --model claude-haiku-5-5 --mcp-config …`
called it and answered "Headline: Australian MP loses both legs after alleged car attack, husband says / Site:
BBC News" — the image reached the model intact.

**Codex: untested** (not installed on this host).

Decision: agent screenshots default to PNG (exact pixels, ≤ ~400 KB base64 even for busy pages); JPEG is
available via `format`; WebP only for dashboard thumbnails (per design.md's parity section).

## 3. Accessibility tree: pass

A ~40-line pyatspi walker (`Registry.getDesktop(0)` → apps → `queryComponent().getExtents(DESKTOP_COORDS)`)
ran in 0.1–0.3 s:

- **mousepad (GTK 3):** 265 named nodes with boxes (frame, menus, …).
- **FeatherPad (Qt 6)** with `QT_ACCESSIBILITY=1 QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1`: 73 named nodes with boxes.
- **Chromium** with only `--force-renderer-accessibility`: **not on the bus at all**. Adding the environment
  variable `ACCESSIBILITY_ENABLED=1` fixed it: 38 named nodes including browser UI ("Address and search bar",
  "Reload") and page content (`heading "Spike page" [22,161,1026,43]`, `button "Press me" [22,225,74,25]`).
- Needs a session D-Bus and `at-spi-bus-launcher` running before apps start.
- Gotcha: items in closed menus report boxes of `[-2147483648, -2147483648, 1, 1]`; the helper must drop
  off-screen/invalid boxes (and prefer `showing`/`visible` nodes).

## 4. Browser tools: pass (with a caveat)

- A 40-line Node proxy inside the container (HTTP `/json/*` with `webSocketDebuggerUrl` rewritten to the proxy's
  host, raw websocket upgrade piped to 127.0.0.1:9222 with `Host: 127.0.0.1:9222` so Chromium accepts it).
- From another container: `createConnection({ browser: { cdpEndpoint: "http://<ip>:7000" } })` from
  `@playwright/mcp@0.0.83` + an `InMemoryTransport` client from `@modelcontextprotocol/sdk` listed 25 tools,
  navigated, snapshotted (`button "Click me" [ref=f1e3]`), clicked, typed, and clicked **the same ref `f1e3`
  again three calls later** — `document.title` went to `clicked-2` and the input held `hello`. Refs stay valid.
- **Caveat (for the manager):** attached to an existing browser, Playwright MCP's "current" tab is the first page,
  which may be a background tab; clicks then time out waiting for "stable" (rAF is throttled in background
  tabs). Calling `browser_tabs {action:"select", index}` first brings it to the front and everything works.
  The manager should select the visible tab when it creates the connection.
- **Schema drift:** in 0.0.83 element tools take `target` (ref or selector), not `ref`. Pin the version and keep
  the contract test the plan calls for.

## Chromium sandbox (needed for phase 1)

| Container security options | Chrome sandbox |
| --- | --- |
| Docker defaults | fails: `No usable sandbox!` (seccomp blocks `unshare(CLONE_NEWUSER)` without CAP_SYS_ADMIN) |
| `seccomp=unconfined` | fails: `Permission denied` — Docker's `docker-default` AppArmor profile blocks creating a user namespace on this kernel |
| `apparmor=unconfined` | fails: seccomp |
| `seccomp=images/desktop/chrome-seccomp.json` + `apparmor=unconfined` | **works** |

`chrome-seccomp.json` is Docker 26's default profile plus one rule allowing `clone`, `unshare` and `setns`
unconditionally (what Chrome's user-namespace sandbox needs). The setuid `chromium-sandbox` helper is no help in a
container without CAP_SYS_ADMIN.

Decision: the image ships `chrome-seccomp.json`; the manager should start desktops with
`--security-opt seccomp=<chrome-seccomp.json>` and, where AppArmor is enabled, `--security-opt apparmor=unconfined`.
The `deskhand-chromium` wrapper probes whether it can create a user namespace (`unshare -U true`); if not (plain
`docker run` with defaults), it falls back to `--no-sandbox`, logs a warning, and records it in
`/run/deskhand/chromium-sandbox` so `/state` and the docs can say so. Trade-off recorded in design.md: AppArmor
unconfined loosens the container's own confinement slightly, in exchange for Chrome's renderer sandbox.
