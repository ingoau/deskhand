# Quickstart

This takes you from nothing to an agent clicking in its own Linux desktop. You need a Linux machine with Docker
Engine and the Compose plugin (`docker compose version`) on amd64 or arm64. See [supported hosts](#supported-hosts)
for Docker Desktop on macOS and Windows.

**How long it takes:** on the reference host, the scripted run below went from `docker compose up -d` to the first
click in a desktop in **15 seconds**. The images had already been downloaded. The one-time download is about
0.9 GB compressed (desktop image about 730 MB, manager about 130 MB), which is about 1–2 minutes on a
50–100 Mbit/s connection. Add the time it takes to paste two blocks of commands, and five minutes is
comfortable.

## 1. Start deskhand

```sh
mkdir deskhand && cd deskhand
curl -fsSLO https://raw.githubusercontent.com/ingoau/deskhand/main/compose.yaml
docker compose up -d --wait
docker compose exec deskhand deskhand login-link
```

This starts one container, `deskhand`, with the manager, dashboard, MCP endpoint and CLI. `--wait` returns once the
manager answers its health check. It listens on `127.0.0.1:7480`, which is reachable only from this machine. To
reach it from other machines, see [remote access](remote-access.md).

The last command prints a dashboard login link. It works once and expires after 5 minutes. Open it in a browser on
this machine and you are signed in for 30 days. Run it again whenever you need a new link.

The manager downloads the desktop image in the background as soon as it starts. Desktops are separate containers
that the manager starts when an agent asks for one. Compose doesn't manage them.

## 2. Connect your agent

Run the block for your agent from the `deskhand` directory. Each block creates a new API token with
`deskhand token create`, named after the agent and the time, and registers deskhand with the agent. Running a block
again replaces the agent's deskhand entry with one that uses a fresh token. Restart the agent afterwards.

### Claude Code

```sh
claude mcp remove -s user deskhand >/dev/null 2>&1
TOKEN=$(docker compose exec -T deskhand deskhand token create "claude-$(date +%Y%m%d-%H%M%S)") &&
claude mcp add -s user --transport http deskhand http://127.0.0.1:7480/mcp --header "Authorization: Bearer $TOKEN"
```

`-s user` makes deskhand available in every project. Check it with `claude mcp list`.

### Codex

```sh
codex mcp remove deskhand >/dev/null 2>&1
TOKEN=$(docker compose exec -T deskhand deskhand token create "codex-$(date +%Y%m%d-%H%M%S)") &&
mkdir -p "${CODEX_HOME:-$HOME/.codex}" && cat >> "${CODEX_HOME:-$HOME/.codex}/config.toml" <<EOF

[mcp_servers.deskhand]
url = "http://127.0.0.1:7480/mcp"
http_headers = { Authorization = "Bearer $TOKEN" }
EOF
```

This appends a `[mcp_servers.deskhand]` table to `~/.codex/config.toml`. Check it with `codex mcp list`.

### OpenCode

Needs `jq`.

```sh
TOKEN=$(docker compose exec -T deskhand deskhand token create "opencode-$(date +%Y%m%d-%H%M%S)") &&
CONF="$HOME/.config/opencode/opencode.json" && mkdir -p "${CONF%/*}" && { [ -s "$CONF" ] || echo '{}' > "$CONF"; } &&
jq --arg auth "Bearer $TOKEN" '."$schema" //= "https://opencode.ai/config.json"
  | .mcp.deskhand = {type: "remote", url: "http://127.0.0.1:7480/mcp", headers: {Authorization: $auth}, enabled: true}' \
  "$CONF" > "$CONF.tmp" && mv "$CONF.tmp" "$CONF"
```

This sets `mcp.deskhand` in `~/.config/opencode/opencode.json` and keeps the rest of the file. If you use
`opencode.jsonc` with comments, add the same entry by hand instead.

### Tokens

On first start the manager also logs a token named `default` (`docker compose logs deskhand | grep '"token"'`). You
don't need it if you used a block above. Manage tokens with the CLI or the dashboard's **settings** page:

```sh
docker compose exec deskhand deskhand token ls
docker compose exec deskhand deskhand token revoke <name>
docker compose exec deskhand deskhand token create laptop   # prints only the token, e.g. dh_…
```

The agent blocks above use `http://127.0.0.1:7480/mcp`, so they work for agents on this machine. For an agent on
another machine, create a token here and use your public URL from [remote access](remote-access.md) in the agent's
config.

### Other MCP clients

Any client that speaks MCP over Streamable HTTP works. Configure:

- **URL:** `http://127.0.0.1:7480/mcp` (or `<your public URL><base path>/mcp` behind a proxy)
- **Header:** `Authorization: Bearer <token>`

For example, in the JSON format that many clients share:

```json
{
  "mcpServers": {
    "deskhand": {
      "type": "http",
      "url": "http://127.0.0.1:7480/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Clients that only support stdio servers can go through a bridge such as `mcp-remote`
(`npx mcp-remote http://127.0.0.1:7480/mcp --header "Authorization: Bearer <token>"`).

## 3. First prompt

Try something small that shows the whole loop:

> Use deskhand: start a desktop, open a terminal by clicking the terminal launcher in the panel at the bottom of the
> screen, and tell me what you see.

Then something real:

> Use a deskhand desktop to open https://news.ycombinator.com in Chromium and summarise the top three stories.

The agent calls `desktop_start` and gets a screenshot back. It then clicks, types and reads web pages with the
`browser_*` tools. When its session ends, its desktop is removed. Ask for `persistent: true` to keep one.

## 4. Watch it in the dashboard

Open the login link from step 1 (or run `deskhand login-link` again). You will see:

- **A tile per desktop** with a live thumbnail, the session and the agent's last action. A green dot means running,
  amber means the agent asked for you (`request_human`), violet means you have control.
- **Click a tile** for the live view. It is view-only until you press **take over**. While you have control the
  agent's input waits. **Hand back** with an optional note, which the agent receives in its next tool result.
- **log** shows every tool call with its screenshot, and click points and drag paths drawn on it.
- **templates** lists saved desktops (apps, settings, logins) that agents can start from.
- **settings** manages API tokens and dashboard sessions, and shows host warnings.

## Using the CLI

The `deskhand` CLI runs inside the manager container:

```sh
docker compose exec deskhand deskhand ls
docker compose exec -T deskhand deskhand screenshot > shot.png
docker compose exec deskhand deskhand --help
```

To skip `docker compose exec`, install the small wrapper script. It finds the manager container by its compose
labels, so it works from any directory:

```sh
curl -fsSL https://raw.githubusercontent.com/ingoau/deskhand/main/scripts/deskhand -o ~/.local/bin/deskhand
chmod +x ~/.local/bin/deskhand
deskhand ls
deskhand screenshot > shot.png        # no TTY when piped, so the PNG stays intact
DESKHAND_PROJECT=other deskhand ls    # a second install with another compose project name
```

## Configuration

Settings are environment variables. Put them in a `.env` file next to `compose.yaml` and run `docker compose up -d`
again. For example, `DESKHAND_MAX_DESKTOPS=4` or `TZ=Europe/Berlin`. Desktops get `TZ` and `LANG` from the
manager, and without them use UTC. All variables are in [configuration](configuration.md). Sizing guidance is in
[sizing](sizing.md).

## Upgrade

```sh
docker compose pull && docker compose up -d
```

Compose recreates only the manager. What happens to desktops:

- **Running desktops keep running.** They aren't managed by compose. The new manager finds them by their labels, and
  they stay on the old desktop image while they run.
- **A stopped desktop moves to the new image when it starts next.** That covers desktops stopped after the idle
  timeout, by you, or by a host reboot. deskhand creates a new container from the new desktop image and copies
  `/home/agent` across, without mounted directories and `~/.cache`. Then it removes the old container. The agent's
  next tool result says so. If anything fails along the way, the old container is kept and started as before.
- **To move a running desktop now,** stop and start it: `deskhand stop <id>`, then `deskhand start <id>`, or the
  dashboard's menu.
- **Saved templates** are images of their own and keep the desktop image they were saved on. Templates with a
  recipe are rebuilt on the new image automatically. Templates without one show "outdated base" until you save
  them again.

Pin a version with `DESKHAND_VERSION=0.1.0` in `.env` to upgrade only when you change it. The manager always uses
the desktop image of its own version.

## Back up

Two things hold state:

- **The `deskhand-data` volume:** the database (templates, tokens, locks, feedback, action log) and action-log
  screenshots.
- **Template images** (`deskhand-template:<name>-v<N>`): your saved desktops, *including their logins*. Treat
  backups as secrets (see [security](security.md)).

Stop the manager for a consistent copy of the database. Desktops keep running.

```sh
docker compose stop deskhand
docker run --rm -v deskhand-data:/data:ro -v "$PWD":/backup busybox:1.37 \
  tar czf /backup/deskhand-data-$(date +%F).tgz -C /data .
docker compose start deskhand

# Template images (all versions; repeat docker save per image, or list several):
docker save -o deskhand-templates-$(date +%F).tar $(docker image ls deskhand-template --format '{{.Repository}}:{{.Tag}}')
```

The archive is written by root, because some files in the volume (such as `admin.json`) are readable only by
their owner. Restore on a fresh install (before or instead of the first `docker compose up -d`):

```sh
docker volume create deskhand-data
docker run --rm -v deskhand-data:/data -v "$PWD":/backup busybox:1.37 \
  tar xzf /backup/deskhand-data-2026-10-22.tgz -C /data
docker load -i deskhand-templates-2026-10-22.tar
docker compose up -d
```

Desktops themselves are not part of a backup. Ephemeral desktops are disposable by design. To keep what is in a
persistent desktop, save it as a template, or copy files out with `file_get` or the dashboard's download.

## Uninstall

```sh
# 1. Remove every desktop (running or stopped). Compose doesn't manage them.
docker rm -f $(docker ps -aq --filter label=owner=deskhand --filter label=deskhand.kind=desktop)
# 2. Remove the manager, the desktop network and the data volume (drop -v to keep your data).
docker compose down -v
# 3. Optionally remove the images: templates, the desktop image and the manager.
docker image rm $(docker image ls -q deskhand-template) 2>/dev/null
docker image rm $(docker image ls -q ghcr.io/ingoau/deskhand-desktop) $(docker image ls -q ghcr.io/ingoau/deskhand)
```

Run step 1 before step 2. If desktops are still attached, `docker compose down` removes the manager but reports the
network as "still in use". If you run several installs on one host, add `--filter label=deskhand.instance=<name>`
in step 1.

## Supported hosts

- **Supported:** Linux with Docker Engine, amd64 and arm64. Images are published for both architectures.
- **Community-tested:** Docker Desktop on macOS and Windows. It should work (desktops are Linux containers in Docker
  Desktop's VM), but it isn't part of regular testing. Mounts refer to paths inside Docker Desktop's VM, and
  `/dev/kvm` is not available.
- **Later:** rootless Docker and Podman.
- **Ubuntu 23.10 and newer** (including GitHub's ubuntu-24.04 runners) set
  `kernel.apparmor_restrict_unprivileged_userns=1`. This blocks the user namespaces that Chromium's sandbox needs, so
  desktops run Chromium with `--no-sandbox`. The manager logs a warning and the dashboard's settings page shows it.
  See [security](security.md#chromium-sandbox) for the fix and the trade-off.
