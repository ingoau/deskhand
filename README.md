# deskhand

Isolated Linux desktops for AI agents, on demand, with one dashboard to watch them all and take over any of them.

Each desktop is a Docker container with Chromium, Firefox and a few native apps. Agents drive it through MCP tools:
the computer-use toolset, `browser_*` tools on the desktop's own Chromium, an accessibility tree, and a shell. You
watch every desktop live in the dashboard and can take over at any moment.

## Quickstart

You need Linux with Docker Engine and the Compose plugin (amd64 or arm64).

```sh
mkdir deskhand && cd deskhand
curl -fsSLO https://raw.githubusercontent.com/ingoau/deskhand/main/compose.yaml
docker compose up -d
docker compose logs deskhand | grep -E 'loginUrl|"token"'   # dashboard login link + first API token
claude mcp add --transport http deskhand http://127.0.0.1:7480/mcp --header "Authorization: Bearer <token>"
```

Then ask your agent: *"Use deskhand: start a desktop, open a terminal from the panel, and tell me what you see."*
Open the login link to watch it.

The full walkthrough is in [docs/quickstart.md](docs/quickstart.md). It covers Codex and other MCP clients, the CLI,
upgrades, backups and uninstalling.

## Docs

- [Quickstart](docs/quickstart.md): install, connect agents, CLI, upgrade, backup, uninstall, supported hosts
- [Remote access](docs/remote-access.md): Tailscale Serve, Caddy (hostname or sub-path), SSH tunnel
- [Configuration](docs/configuration.md): every environment variable
- [Security](docs/security.md): what deskhand protects and what it doesn't; read it before exposing deskhand
- [Sizing](docs/sizing.md): how many desktops a host runs
- [Design](docs/design.md) and [plan](docs/plan.md): how it is built

Licensed under Apache-2.0. Bundled third-party software keeps its own licenses; see [NOTICE](NOTICE). Contributions
use the DCO; see [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).
