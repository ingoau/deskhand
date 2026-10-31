# deskhand

Isolated Linux desktops for AI agents, on demand, with one dashboard to watch them all and take over any of them.

Each desktop is a Docker container with Chromium, Firefox and a few native apps. Agents drive it through MCP tools:
the computer-use toolset, `browser_*` tools on the desktop's own Chromium, an accessibility tree, and a shell. You
watch every desktop live in the dashboard and can take over at any moment.

## Quickstart

**1. Start deskhand.** You need Linux with Docker Engine and the Compose plugin (amd64 or arm64).

```sh
mkdir deskhand && cd deskhand
curl -fsSLO https://raw.githubusercontent.com/ingoau/deskhand/main/compose.yaml
docker compose up -d --wait
docker compose exec deskhand deskhand login-link   # open it to watch your agents (single use, 5 minutes)
```

**2. Connect your agent.** Run the block for your agent in the same directory. Each one creates a new API token and
registers deskhand with the agent.

Claude Code:

```sh
claude mcp remove -s user deskhand >/dev/null 2>&1
TOKEN=$(docker compose exec -T deskhand deskhand token create "claude-$(date +%Y%m%d-%H%M%S)") &&
claude mcp add -s user --transport http deskhand http://127.0.0.1:7480/mcp --header "Authorization: Bearer $TOKEN"
```

Codex:

```sh
codex mcp remove deskhand >/dev/null 2>&1
TOKEN=$(docker compose exec -T deskhand deskhand token create "codex-$(date +%Y%m%d-%H%M%S)") &&
mkdir -p "${CODEX_HOME:-$HOME/.codex}" && cat >> "${CODEX_HOME:-$HOME/.codex}/config.toml" <<EOF

[mcp_servers.deskhand]
url = "http://127.0.0.1:7480/mcp"
http_headers = { Authorization = "Bearer $TOKEN" }
EOF
```

OpenCode (needs `jq`):

```sh
TOKEN=$(docker compose exec -T deskhand deskhand token create "opencode-$(date +%Y%m%d-%H%M%S)") &&
CONF="$HOME/.config/opencode/opencode.json" && mkdir -p "${CONF%/*}" && { [ -s "$CONF" ] || echo '{}' > "$CONF"; } &&
jq --arg auth "Bearer $TOKEN" '."$schema" //= "https://opencode.ai/config.json"
  | .mcp.deskhand = {type: "remote", url: "http://127.0.0.1:7480/mcp", headers: {Authorization: $auth}, enabled: true}' \
  "$CONF" > "$CONF.tmp" && mv "$CONF.tmp" "$CONF"
```

**3. Try it.** Restart your agent and ask: *"Use deskhand: start a desktop, open a terminal from the panel, and tell
me what you see."* Watch it in the dashboard from step 1.

The full walkthrough is in [docs/quickstart.md](docs/quickstart.md). It covers other MCP clients, agents on another
machine, the CLI, upgrades, backups and uninstalling.

## Docs

- [Quickstart](docs/quickstart.md): install, connect agents, CLI, upgrade, backup, uninstall, supported hosts
- [Remote access](docs/remote-access.md): Tailscale Serve, Caddy (hostname or sub-path), SSH tunnel
- [Configuration](docs/configuration.md): every environment variable
- [Security](docs/security.md): what deskhand protects and what it doesn't; read it before exposing deskhand
- [Sizing](docs/sizing.md): how many desktops a host runs
- [Android](docs/android.md): running the Android emulator in a desktop (opt-in KVM, more memory/CPUs)
- [Design](docs/design.md) and [plan](docs/plan.md): how it is built

Licensed under Apache-2.0. Bundled third-party software keeps its own licenses; see [NOTICE](NOTICE). Contributions
use the DCO; see [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).
