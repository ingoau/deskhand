# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's "Report a vulnerability" button on the
repository's Security tab (private vulnerability reporting). Do not open a public issue.

Include what you found, how to reproduce it, and the deskhand version (`deskhand --version` or the image tag).
We aim to acknowledge reports within 3 working days.

## What deskhand does and does not protect

deskhand is a guardrail, not a security boundary. Read "Mounts and security" in `docs/security.md` before
exposing it beyond localhost. In short:

- The manager container mounts the Docker socket, which is root-equivalent on the host.
- Agents that are in the host's `docker` group can bypass deskhand entirely.
- Desktops share an internal network and can reach each other's daemons and services on the host network.
- Templates store login cookies unencrypted in Docker images; action logs store screenshots of whatever was on
  screen.
- Anything shown on a desktop's screen can contain prompt injection.
