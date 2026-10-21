# Remote access

The manager publishes one port, `127.0.0.1:7480` by default (`DESKHAND_BIND`). That port carries the dashboard,
the REST API, the MCP endpoint (`/mcp`) and the live-view websocket. Only the manager publishes a port. Desktops
are reached through it.

deskhand doesn't configure any proxy, tunnel or VPN itself. Keep the port on localhost and put one of the setups below
in front of it. Every example on this page was tested against a real deskhand. The test covered the login link,
the dashboard (including the live view where noted), and a real Claude Code session that used the MCP endpoint
to start a desktop and click in it. Test notes are at the end.

**Two settings matter behind a proxy:**

- `DESKHAND_PUBLIC_URL`: the origin people and agents use, such as `https://deskhost.tail1234.ts.net`. Leave out the
  path. Printed login links and MCP URLs use it. The cross-site check accepts it as the dashboard's origin, in
  addition to whatever `Host` the request arrived with.
- `DESKHAND_BASE_PATH`: set it, for example to `/deskhand`, when deskhand shares a hostname with other services under
  a sub-path. Everything moves under it: `/deskhand/` (dashboard), `/deskhand/api`, `/deskhand/mcp`,
  `/deskhand/auth`, `/deskhand/healthz`. The proxy must forward the prefix unchanged (don't strip it).

Put both in the `.env` file next to `compose.yaml` and run `docker compose up -d`. The session cookie is scoped to the
base path, and it is `Secure` whenever the proxy says the request came over HTTPS (`X-Forwarded-Proto`, trusted by
default; see `DESKHAND_TRUST_PROXY`). WebSockets must be proxied, because the live view uses one. All three setups
below handle that without extra config.

Agents on other machines then use `<public URL><base path>/mcp`, for example:

```sh
claude mcp add --transport http deskhand https://deskhost.tail1234.ts.net/deskhand/mcp --header "Authorization: Bearer <token>"
```

## Tailscale Serve

Tailscale Serve gives the manager an HTTPS address on your tailnet, with a certificate, without opening any port to
the internet. Run it on the deskhand host:

```sh
# The whole HTTPS port for deskhand (simplest, if you own the tailnet name's port 443):
tailscale serve --bg http://127.0.0.1:7480
```

```sh
# .env
DESKHAND_PUBLIC_URL=https://deskhost.tail1234.ts.net
```

Or keep port 443 for something else and use a sub-path or another HTTPS port:

```sh
tailscale serve --bg --https=8443 --set-path=/deskhand http://127.0.0.1:7480/deskhand
```

```sh
# .env
DESKHAND_BASE_PATH=/deskhand
DESKHAND_PUBLIC_URL=https://deskhost.tail1234.ts.net:8443
```

- `tailscale status --json` shows your machine's name (`Self.DNSName`). `tailscale serve status` shows what is being
  served.
- Remove it with `tailscale serve --https=443 off` (or `--https=8443 off`). Don't use `tailscale serve reset`
  unless deskhand is the only thing you serve: it clears every Serve setting on the machine.
- Serve tells deskhand that the request came over HTTPS, so the session cookie is `Secure` (checked in the tests below).
- Anyone on your tailnet can reach the login page. They still need a login link or an API token. Use Tailscale ACLs if
  you want to narrow it further. Don't use `tailscale funnel` for deskhand: that would put it on the public internet.

## Caddy

Caddy terminates TLS and proxies WebSockets with a plain `reverse_proxy`.

**Dedicated hostname.** deskhand gets the whole site, with no base path:

```caddyfile
desk.example.com {
	reverse_proxy 127.0.0.1:7480
}
```

```sh
# .env
DESKHAND_PUBLIC_URL=https://desk.example.com
```

**Sub-path next to other services.** Use `handle`, not `handle_path`, because deskhand needs to see the prefix:

```caddyfile
example.com {
	redir /deskhand /deskhand/ 308
	handle /deskhand/* {
		reverse_proxy 127.0.0.1:7480
	}
	handle {
		# your other services
	}
}
```

```sh
# .env
DESKHAND_BASE_PATH=/deskhand
DESKHAND_PUBLIC_URL=https://example.com
```

If Caddy runs in Docker, give it `network_mode: host`, or put it on a network with the deskhand container and
proxy to `deskhand:7480`. A plain `127.0.0.1` inside a Caddy container is the Caddy container itself. Any other
reverse proxy (nginx, Traefik, HAProxy) works the same way. It must forward the path unchanged, pass `Host` and
`X-Forwarded-Proto`, allow WebSocket upgrades, and not buffer or time out long-lived responses. MCP clients keep
an event stream open, and deskhand sends a keepalive on it every 25 seconds.

## SSH tunnel

No proxy at all: forward the port over SSH from the machine you sit at.

```sh
ssh -N -L 7480:127.0.0.1:7480 you@deskhost
```

Now `http://127.0.0.1:7480` on your laptop is the deskhand on `deskhost`. Login links printed on `deskhost` work
unchanged, because they also say `127.0.0.1:7480`. Agents on your laptop use `http://127.0.0.1:7480/mcp`. If the local
port differs (`-L 17480:127.0.0.1:7480`), replace the port in printed links. Or set
`DESKHAND_PUBLIC_URL=http://127.0.0.1:17480` on the host.

The SSH server must allow local forwarding (`AllowTcpForwarding yes` or `local`, the OpenSSH default).
Add `-f` to put the tunnel in the background, or use `autossh` to keep it up.

## How these were tested

Tested on 2026-10-22 with the phase 6 images, a separate compose project per setup, and Claude Code 2.1.306
(`claude -p`, `--model claude-sonnet-5-5`, only deskhand's MCP tools). In each Claude run the agent called
`desktop_start` and clicked the terminal launcher. An xterm window was then confirmed inside the desktop with
`wmctrl -l`.

| Setup | What was checked |
| --- | --- |
| Caddy 2, sub-path `/deskhand`, HTTPS with Caddy's internal CA (`https://localhost:<port>/deskhand`) | Login link: 303 to `/deskhand/`, cookie `Path=/deskhand; HttpOnly; Secure; SameSite=Strict`. The same link a second time: `?login=expired`. Dashboard and assets load. The grid polls (thumbnails and `/api/desktops` every 1–2 s). The live view connects over `wss://…/deskhand/api/desktops/<id>/vnc`. Take over, type into an xterm through the live view (file created in the desktop), hand back (Playwright, Chromium). RFB handshake `RFB 003.008` through the proxy. Websocket with a foreign or missing `Origin`: 403. Cookie write without `Origin`: 403; with the right origin: 200. MCP `initialize`/`tools/list` (49 tools). A Claude Code session over HTTPS (`NODE_EXTRA_CA_CERTS` pointing at Caddy's root) clicked in a desktop. |
| Caddy 2, same sub-path over plain HTTP | Login works, and the cookie has no `Secure` flag. |
| Caddy 2, dedicated hostname (`https://desk.localhost:<port>`, no base path) | Login link, cookie `Path=/; Secure`, dashboard, origin checks, MCP `initialize`/`tools/list`. |
| `DESKHAND_PUBLIC_URL` set, request through a different `Host` | A cookie write with `Origin` = the public URL is accepted (200). An unrelated origin is refused (403). |
| Tailscale Serve, `--https=8443 --set-path=/deskhand` | Printed login link uses the tailnet URL. Bare `/deskhand` redirects (308) to `/deskhand/`. Login sets a `Secure` cookie. Dashboard, API and origin checks work. VNC websocket handshake (`RFB 003.008`); foreign origin refused. MCP `initialize`/`tools/list`. A Claude Code session over the tailnet URL clicked in a desktop. The temporary 8443 config was removed afterwards, and `tailscale serve status --json` was identical to before. |
| SSH tunnel (OpenSSH server in a throwaway container on the host network, `ssh -N -L`) | No base path: login link, dashboard, origin checks, and a Claude Code session that clicked in a desktop. Sub-path manager: VNC websocket handshake and MCP `initialize`/`tools/list`. |
