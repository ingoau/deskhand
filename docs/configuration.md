# Configuration

deskhand is configured with environment variables on the manager container. `compose.yaml` lists the common
ones. Each has a `${VAR:-default}` fallback, so you can set them from your shell or from a `.env` file next to
`compose.yaml` without editing the file:

```sh
# .env next to compose.yaml
DESKHAND_BIND=127.0.0.1:7480
DESKHAND_MAX_DESKTOPS=4
TZ=Europe/Berlin
```

Then apply the change with `docker compose up -d`, which recreates the manager. Desktops keep running.

To set a variable that `compose.yaml` doesn't list, add it under `services.deskhand.environment` in your own copy of
`compose.yaml`, or in a `compose.override.yaml`. Invalid values stop the manager at startup with a message that
names the variable (`docker compose logs deskhand`).

**Formats:**
- **Durations:** `500ms`, `30s`, `30m`, `24h`, `7d`.
- **Sizes:** `512m`, `2g`, or plain bytes.
- **Switches:** `on`/`off` (also `true`/`false`, `1`/`0`, `yes`/`no`).

## Compose settings

These are read by `compose.yaml` itself, not by the manager.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DESKHAND_PROJECT` | `deskhand` | Compose project name. Change it to run a second deskhand on the same Docker host. |
| `DESKHAND_VERSION` | `latest` | Tag of `ghcr.io/ingoau/deskhand` to run. Pin it, for example `0.1.0`, to upgrade only when you choose. |
| `DESKHAND_DATA_VOLUME` | `deskhand-data` | Name of the Docker volume that holds the database, tokens and action-log screenshots. |
| `DESKHAND_DOCKER_SOCKET` | `/var/run/docker.sock` | Host path of the Docker socket that is mounted into the manager. Set it for a non-standard socket location. |

## Limits and timeouts

| Variable | Default | Meaning |
| --- | --- | --- |
| `DESKHAND_MAX_DESKTOPS` | `8` | Most desktops running at once. Requests over the limit get `limit_reached`. |
| `DESKHAND_MEMORY_BUDGET` | `80%` | Total memory that running desktops may reserve: a percentage of host memory or a size (`24g`). Admission counts each desktop's memory cap, not what it actually uses. |
| `DESKHAND_DESKTOP_MEMORY` | `2g` | Default memory cap per desktop. |
| `DESKHAND_DESKTOP_CPUS` | `1.5` | Default CPU cap per desktop. |
| `DESKHAND_DESKTOP_MAX_MEMORY` | `8g` | Largest `memory` an agent or the dashboard may ask for in one desktop. Must be at least `DESKHAND_DESKTOP_MEMORY`. |
| `DESKHAND_DESKTOP_MAX_CPUS` | `4` | Largest `cpus` one desktop may ask for. It is also capped at the host's CPU count, and must be at least `DESKHAND_DESKTOP_CPUS`. |
| `DESKHAND_KVM` | `auto` | `auto`: a desktop started with `kvm: true` gets `/dev/kvm` if the Docker host has it. `off`: never. See [security](security.md#opt-in-kvm). |
| `DESKHAND_IDLE_TIMEOUT` | `30m` | A desktop with no tool calls for this long is stopped. Its files are kept, and the next tool call starts it again. |
| `DESKHAND_STOPPED_RETENTION` | `24h` | Stopped ephemeral desktops are removed after this. Persistent desktops are only removed by you. |
| `DESKHAND_SESSION_TIMEOUT` | `24h` | An MCP session with no requests for this long ends, and its ephemeral desktops are removed. |
| `DESKHAND_SESSION_DISCONNECT_GRACE` | `60s` | A session whose client closed its event stream, and didn't come back within this time, ends early. `0` turns this off. |
| `DESKHAND_REQUEST_HUMAN_TIMEOUT` | `10m` | How long `request_human` waits for you before it returns "still waiting". |
| `DESKHAND_LOCK_WAIT` | `30s` | How long `browser_*` calls wait while you hold the takeover lock. Pixel input and `desktop_exec` wait the same time in the daemon. |
| `DESKHAND_START_TIMEOUT` | `60s` | Time a desktop has to become ready after its container starts. |
| `DESKHAND_FILE_MAX_BYTES` | `512m` | Largest file for `file_put`/`file_get` and dashboard uploads and downloads. |

## Network, URLs and login

| Variable | Default | Meaning |
| --- | --- | --- |
| `DESKHAND_BIND` | `127.0.0.1:7480` | Address published on the host (compose maps it to the container's port 7480). Printed links use it unless `DESKHAND_PUBLIC_URL` is set. Keep it on localhost and put a proxy or tunnel in front: see [remote access](remote-access.md). |
| `DESKHAND_LISTEN` | `0.0.0.0:7480` (image) | Address the manager process listens on inside its container. You normally never change it. |
| `DESKHAND_BASE_PATH` | (empty) | Serve the dashboard, API, MCP endpoint and live view under a sub-path such as `/deskhand`, behind a reverse proxy that keeps the prefix. |
| `DESKHAND_PUBLIC_URL` | (empty) | Origin that users and agents use to reach deskhand through a proxy, such as `https://host.tailnet.ts.net` (no path; the base path is added). Used in printed login links and MCP URLs. It is also accepted by the cross-site origin check. |
| `DESKHAND_TRUST_PROXY` | `on` | Trust `X-Forwarded-Proto`/`-Host`/`-For` from a reverse proxy, so the session cookie is `Secure` behind HTTPS. Turn it off if clients can reach the manager's port directly *and* you don't want them to choose those headers. |
| `DESKHAND_AUTH` | `on` | `off` disables login links, cookies and API tokens entirely. Only for a manager nobody else can reach. |

## Desktops

| Variable | Default | Meaning |
| --- | --- | --- |
| `DESKHAND_DESKTOP_IMAGE` | `ghcr.io/ingoau/deskhand-desktop:<manager version>` | Image for new desktops and for the `base` template. The default always matches the manager's version. |
| `DESKHAND_NETWORK` | `deskhand-desktops` | Docker network shared by the desktops and the manager. Compose creates it. |
| `DESKHAND_SCREEN` | `1280x800` | Screen size of new desktops (up to `1920x1080`). Screenshot pixels equal screen pixels. |
| `DESKHAND_CHROME_SANDBOX` | `on` | Start desktops with Chrome's seccomp profile (plus `apparmor=unconfined` on AppArmor hosts), so Chromium keeps its renderer sandbox. `off` starts desktops with Docker's defaults, and Chromium falls back to `--no-sandbox`. See [security](security.md#chromium-sandbox). |
| `DESKHAND_SECCOMP_PROFILE` | `/opt/deskhand/chrome-seccomp.json` | Path inside the manager container to the seccomp profile used when the sandbox is on. |
| `DESKHAND_AGENT_UID` / `DESKHAND_AGENT_GID` | `1000` / `1000` | UID and GID of the `agent` user in desktops. Files that agents write to mounted host directories get this owner. Set them to your `id -u` / `id -g`. |
| `DESKHAND_MOUNT_ALLOW` | (empty) | Comma-separated absolute host paths. If set, desktops may only mount paths inside them. |
| `DESKHAND_MOUNT_DENY` | (empty) | Comma-separated absolute host paths that desktops may never mount. The Docker socket is always refused. |
| `DESKHAND_DOCKER_SOCKET_PATHS` | `/var/run/docker.sock,/run/docker.sock` | Host paths of the Docker socket. They and their parent directories are always refused as mounts. Add yours if it lives elsewhere. |
| `DESKHAND_HELPER_IMAGE` | `busybox:1.37` | Small image for short-lived helper containers: resolving host paths, copying files and checking for `/dev/kvm`. |
| `TZ`, `LANG` | host shell's values | Passed to every desktop. Without them, desktops use UTC and `C.UTF-8`. |

## Templates

| Variable | Default | Meaning |
| --- | --- | --- |
| `DESKHAND_TEMPLATE_VERSIONS` | `5` | Versions kept per template, plus the current one and any version a desktop still uses. |
| `DESKHAND_TEMPLATE_REPO` | `deskhand-template` | Image repository for saved template versions (`<repo>:<name>-v<N>`). |
| `DESKHAND_TEMPLATE_STALE_AFTER` | `14d` | A template not confirmed working for this long is marked stale. |
| `DESKHAND_TEMPLATE_AUTO_REBUILD` | `on` | Rebuild recipe-backed templates automatically when the desktop image changes. |
| `DESKHAND_TEMPLATE_CARRY` | `.config/chromium,.mozilla,.config/mozilla,.local/share/keyrings,.pki` | Paths in the agent's home that a rebuild copies from the old snapshot: browser profiles with their logins, the keyring and the certificate store. |
| `DESKHAND_RECIPE_TIMEOUT` | `20m` | Time limit for one recipe run during a rebuild. |

## Logs, screenshots and tools

| Variable | Default | Meaning |
| --- | --- | --- |
| `DESKHAND_LOG_RETENTION` | `7d` | Keep full action-log screenshots this long, then thumbnails only. |
| `DESKHAND_LOG_THUMB_RETENTION` | `30d` | Thumbnails and log rows of removed desktops are deleted after this. |
| `DESKHAND_SCREENSHOT_MAX_BYTES` | `72k` | Size budget for screenshots returned to agents. A screenshot that is too large as PNG is sent as JPEG, never resized. |
| `DESKHAND_SCREENSHOT_QUALITY` | `80` | Starting JPEG quality when a screenshot has to be JPEG. |
| `DESKHAND_BROWSER_TOOLS` | `on` | Offer the `browser_*` tools (Playwright MCP attached to the desktop's Chromium). |
| `DESKHAND_LOG_LEVEL` | `info` | Manager log level (`debug`, `info`, `warn`, `error`). Logs are JSON lines on stdout. |

## Several installs on one Docker host

The manager only touches containers that carry its owner label. If `DESKHAND_INSTANCE` is set, it also needs that
instance label. Give each install its own project, port, network, volume and instance:

| Variable | Default | Meaning |
| --- | --- | --- |
| `DESKHAND_INSTANCE` | (empty) | Instance name stored as a label on everything this manager creates. |
| `DESKHAND_OWNER_LABEL` | `deskhand` | Value of the `owner` label on desktops, helpers and template images. |
| `DESKHAND_CONTAINER_PREFIX` | `deskhand-` | Prefix of desktop container names. |

## Internal and development

These are for the image, tests and development. Leave them alone in normal use.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DESKHAND_DATA_DIR` | `/data` | Data directory inside the manager container (the `deskhand-data` volume). |
| `DESKHAND_DASHBOARD_DIR` | the image's dashboard build | Directory of the dashboard's static files. Empty means a placeholder page. |
| `DESKHAND_RUNTIME` | `docker` | `fake` runs in-process fake desktops, for tests and dashboard development. |
| `DESKHAND_HEALTH_INTERVAL` | `5s` | How often each running desktop's daemon is checked. |
| `DESKHAND_UNHEALTHY_AFTER` | `60s` | A desktop that fails health checks for this long is restarted. |
| `DESKHAND_SWEEP_INTERVAL` | `15s` | How often idle stop and retention removal run. |
| `DESKHAND_STATS_INTERVAL` | `5s` | How often CPU and memory figures are refreshed. |

The CLI (`deskhand …`) also reads `DESKHAND_URL` and `DESKHAND_TOKEN` when you run it outside the manager
container. Inside the container it uses the admin credential in `/data/admin.json`.
