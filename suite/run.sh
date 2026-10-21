#!/usr/bin/env bash
# deskhand reliability suite — real Claude Code sessions, run on demand (not in regular CI).
#
#   suite/run.sh                     # the phase 2 set: contract, two_sessions, subagents
#   suite/run.sh two_sessions -v     # one task, verbose
#
# Needs, on the machine running it: a deskhand manager, the `claude` CLI (logged in), python3, and the docker
# CLI for container-level checks. The desktops must be able to mount /tmp of this machine, i.e. run this on
# the Docker host. Configuration:
#   DESKHAND_URL            manager URL (default http://127.0.0.1:7480)
#   DESKHAND_TOKEN          an API token (`docker compose exec deskhand deskhand token create suite`), or
#   DESKHAND_COMPOSE_PROJECT  a compose project name: a throwaway token is created there and revoked after
#   DESKHAND_SUITE_MODEL    default claude-sonnet-5-5 (computer use needs it; haiku only for trivial checks)
#   DESKHAND_SUITE_BUDGET_USD  max spend per claude session (default 3)
#   DESKHAND_SUITE_GRACE    seconds the manager may take to notice a session ended (default 90; Claude Code
#                           exits without DELETE, so this is DESKHAND_SESSION_DISCONNECT_GRACE + one sweep)
# Results (transcripts, monitor snapshots, summary.json): suite/results/<timestamp>/.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

token_name=""
if [ -z "${DESKHAND_TOKEN:-}" ] && [ -n "${DESKHAND_COMPOSE_PROJECT:-}" ]; then
  token_name="suite-$(date +%Y%m%d-%H%M%S)"
  DESKHAND_TOKEN="$(docker compose -p "$DESKHAND_COMPOSE_PROJECT" exec -T deskhand deskhand token create "$token_name" 2>/dev/null)"
  export DESKHAND_TOKEN
  trap 'docker compose -p "$DESKHAND_COMPOSE_PROJECT" exec -T deskhand deskhand token revoke "$token_name" >/dev/null 2>&1 || true' EXIT
fi

python3 -I "$here/runner.py" "$@"
