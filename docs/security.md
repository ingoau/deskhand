# Security

deskhand keeps agents' desktops separate from each other and from your own screen. It makes their behaviour
visible, and it lets you take over at any moment. **It is a guardrail, not a security boundary.** This page explains
what that means in practice, so you can decide what to run with it and how to expose it. To report a vulnerability,
see [SECURITY.md](../SECURITY.md).

## Guardrail, not a boundary

- **The manager holds the Docker socket.** Access to the Docker socket is root-equivalent on the host. The manager
  container is the only one that gets it. Desktops never do, and the socket is always refused as a desktop mount.
  The manager process runs as an unprivileged user with the socket's group and no capabilities. Anyone who
  controls the manager still controls the host's Docker, so protect its port (see [Exposure](#exposure)).
- **Agents in the `docker` group can bypass deskhand.** Agents usually run as a user that is in the host's `docker`
  group. Such an agent can ignore deskhand and run `docker run -v /:/host …` itself. deskhand keeps what agents do
  consistent and visible, but a real boundary needs agents outside the `docker` group, or sandboxed.
- **`desktop_exec` is a shell in the desktop**, as the unprivileged `agent` user. It sees only the container's own
  filesystem and the mounts the agent asked for. It never gets the daemon's key, the Docker socket or host
  credentials.

## Mounts

Desktops start with **no host directories mounted**. Agents mount what they need by passing `mounts` to
`desktop_start`. Nothing is mounted automatically.

- A mount is a host directory at the **same path** inside the desktop. It is **read-only** unless the agent asks for
  write access. Paths always refer to the deskhand host, even when the agent runs on another machine.
- Files the agent writes to a mount are owned by `DESKHAND_AGENT_UID`/`DESKHAND_AGENT_GID` (default 1000:1000) on the
  host.
- **Optional restrictions:** `DESKHAND_MOUNT_ALLOW` (only these trees) and `DESKHAND_MOUNT_DENY` (never these). Both are
  empty by default, so an agent can mount any host directory the Docker daemon can see, apart from the built-in
  protections below. Set an allow-list if your agents don't need the whole disk. For example,
  `DESKHAND_MOUNT_ALLOW=/home/you/projects`.
- **Built-in host protection:** host system directories (`/etc`, `/root`, `/usr`, `/boot`, `/var/lib/docker`, …) and
  home-directory dotfiles that hold credentials or run code (`~/.ssh`, `~/.aws`, `~/.bashrc`, `~/.config`,
  `~/.local/bin`, …; the list is in `packages/manager/src/mounts.ts`) are refused for mounts, `file_put` and
  `file_get`, and so is mounting a whole home directory. Docker writes `file_get` files as root, so without this a
  prompt-injected agent could edit `/etc` or `~/.bashrc` and run code on the host. A path inside a
  `DESKHAND_MOUNT_ALLOW` entry skips these checks.
- Paths are resolved through symlinks *on the host* before they are checked, by a short-lived helper container,
  because the manager can't see the host's filesystem. A symlink can't smuggle in a denied path.
- Always refused: the Docker socket and every directory that contains it, and mount targets that would hide a
  desktop's system directories (`/etc`, `/usr`, `/tmp`, `/home/agent`, …).
- Downloads land in `~/Downloads` inside the desktop, not on the host. Agents copy files out with `file_get` (which
  follows the same mount rules) or save into a mounted directory.

## No secrets in desktops

Desktops get no host credentials and no environment secrets from the manager. They don't get API tokens either, so
code running in a desktop can't call the manager's API. Each desktop's daemon has its own random key. The key lives
in a root-only tmpfs and is removed from the environment before any `agent` process starts.

**What you put on a desktop is a different matter.** Logins you or your agents save in a template are usable by every
agent that starts from it. The dashboard and `template_list` show each template's logged-in sites, so keep
high-value accounts in separate templates, or out of deskhand entirely.

## Data at rest

deskhand stores two kinds of sensitive data unencrypted:

- **Templates hold login cookies.** A template is a Docker image (`deskhand-template:<name>-v<N>`) made with
  `docker commit`. Browser profiles, cookies and local storage are stored in it as plain files. Anyone who can read
  your Docker images can read them. Don't push template images to a registry, and treat template backups as secrets.
- **Action logs hold screenshots** of whatever was on screen at each step: pages, documents, and sometimes passwords
  as you typed them while you had control. They are in the `deskhand-data` volume, kept in full for
  `DESKHAND_LOG_RETENTION` (7 days), then as thumbnails until `DESKHAND_LOG_THUMB_RETENTION` (30 days) after the
  desktop is removed.
- The `deskhand-data` volume also holds the database: token hashes (SHA-256 of 256-bit random tokens), dashboard
  session hashes, and the CLI's admin credential (`admin.json`, mode 0600, rotated at every manager start).

## Prompt injection

Anything shown on a desktop's screen can contain instructions aimed at the agent: a web page, an email, a document,
a file name. deskhand's agent instructions tell the model to treat on-screen text as data, not as instructions from
the user. They also tell it to ask before anything irreversible (purchases, payments, sent messages, submitted
forms, accepted terms, deletions). That is the main defence, and it is not a guarantee.

Anthropic's prompt-injection classifiers for screenshots run only with the official computer-use tool type, not with
MCP tools such as deskhand's. Keep a human in the loop for consequential actions. Use `request_human` and takeover
for logins and confirmations. Don't give an agent's desktop access to accounts it doesn't need.

## Accepted risk: desktops share a network

Desktops sit on one Docker network (`deskhand-desktops`) with the manager and each other. Code running inside a
desktop, through `desktop_exec` or code an agent was tricked into running, can open connections to other containers
on that network:

- It **cannot use the manager's API**: every API and MCP call needs a token or a dashboard session, and desktops have
  neither.
- It **can reach another desktop's daemon port**, but every daemon route except `/health` needs that desktop's own key.
- It can reach **services on the host's network** and the internet. Desktops need outbound access to browse.

This is accepted: an agent tricked into running code already has worse options. If you run sensitive services on the
host or the local network, keep in mind that desktops can reach them like any other container. An egress allow-list
may come later.

## Container hardening

Desktops drop `NET_RAW`, `MKNOD`, `AUDIT_WRITE` and `SETFCAP`, run with `no-new-privileges` (setuid binaries can't
regain root, even one a root recipe left in a template) and are capped at 8192 processes.

## Chromium sandbox

Chromium's renderer sandbox needs unprivileged user namespaces, which Docker's default seccomp and AppArmor profiles
block. With `DESKHAND_CHROME_SANDBOX=on` (the default), desktops are therefore started with:

- deskhand's seccomp profile, which is Docker's default plus `clone`/`unshare`/`setns` for the sandbox;
- `apparmor=unconfined` on AppArmor hosts.

No capabilities are added and the container stays unprivileged. The trade-off: the container's own AppArmor
confinement is lifted, and in return each Chromium renderer runs in its own sandbox. That matters more, because
renderers handle untrusted web content. With `DESKHAND_CHROME_SANDBOX=off`, desktops use Docker's defaults and
Chromium runs with `--no-sandbox`.

**Ubuntu 23.10 and newer** (and GitHub's `ubuntu-24.04` runners) set `kernel.apparmor_restrict_unprivileged_userns=1`.
This host-wide setting blocks the user namespaces even with the options above, so desktops fall back to
`--no-sandbox` and report `chromiumSandbox: "off"`. deskhand detects it: the manager logs a warning at startup, and
the dashboard shows it under **settings → host warnings**. It does the same when a desktop reports the sandbox off. To
keep the sandbox:

```sh
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/60-deskhand-userns.conf
```

Ubuntu restricts unprivileged user namespaces because they widen the kernel's attack surface for every local user
and process. Setting it to 0 brings back the behaviour of most other distributions. The alternative is to leave the
setting alone and accept Chromium without its renderer sandbox. The page then runs only inside the container
(unprivileged, seccomp on). Choose based on what your agents browse.

## Opt-in KVM

A desktop started with `kvm: true` (`desktop_start`, the dashboard's "+ new", `deskhand start --kvm`) gets the host's
`/dev/kvm`. Workloads like the Android emulator need it (see [android.md](android.md)). It is **opt-in per desktop and
widens host exposure**:

- The container gets the `/dev/kvm` device and nothing else: no added capabilities, not privileged. Inside the
  container, the device node is group-owned by the agent's primary group (mode 0660), so the agent user can use it.
  The host's own `/dev/kvm` keeps its owner and mode.
- Code in that desktop can talk to the host kernel's KVM interface directly. That is a larger kernel attack surface
  than an ordinary container has. Enable it only for agents and workloads you would trust with that.
- `DESKHAND_KVM=off` refuses `kvm: true` everywhere (`kvm_unavailable`). Larger per-desktop memory and CPU limits are
  capped by `DESKHAND_DESKTOP_MAX_MEMORY` and `DESKHAND_DESKTOP_MAX_CPUS`.

## Exposure

- The manager's port defaults to `127.0.0.1:7480`. Keep it there and reach it through Tailscale Serve, a reverse
  proxy with TLS, or an SSH tunnel ([remote access](remote-access.md)). Never publish it on a public interface
  without TLS.
- **Authentication** is on by default. The dashboard uses one-time login links (5 minutes, single use) and a session
  cookie (`HttpOnly`, `SameSite=Strict`, `Secure` over HTTPS, scoped to the base path, 30 days). **Sign out
  everywhere** ends all sessions. Agent hosts use named API tokens, one per host, revocable on their own. Agent tokens
  can't create tokens or login links.
- **Cross-site protection:** state-changing dashboard requests and the live-view websocket must come from the
  dashboard's own origin: the request's host, or `DESKHAND_PUBLIC_URL`.
- `DESKHAND_AUTH=off` removes all of this. Use it only when nothing but you can reach the port.
- Behind a proxy, deskhand trusts `X-Forwarded-*` headers by default (`DESKHAND_TRUST_PROXY=on`). If other machines
  can reach the manager's port directly, bypassing your proxy, keep it bound to localhost.
- The live view's input is enforced by the desktop's daemon: view connections can never send keyboard, mouse or
  clipboard input. Control connections only work while you hold the takeover lock.
