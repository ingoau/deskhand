# deskhand — notes for agents working on this repo

deskhand gives every agent its own isolated Linux desktop (a Docker container) via MCP tools, and gives
the human one dashboard to watch them all and take over. The full plan is `docs/plan.md`; design decisions
and cross-package contracts are in `docs/design.md` (read it before changing an interface).

## Machine rules (shared agent host)
- No Node on the host. Run every Node/pnpm command through `scripts/dev` (a throwaway `node:24-bookworm`
  container with the repo mounted at the same path, host networking):
  `scripts/dev pnpm install`, `scripts/dev pnpm -r build`, `scripts/dev pnpm --filter @deskhand/daemon test`.
  `DEV_DOCKER=1 scripts/dev …` also mounts the Docker socket (needed for manager integration tests).
- Docker resources you create: label them `owner=deskhand-dev` (dev/test) — deskhand itself labels its own
  `owner=deskhand`. Never remove Docker resources you didn't create. Clean up test containers.
- Check a port is free (`ss -ltnp`) before binding. 3773 and 443 belong to other services — never touch them.
- Don't install system packages; don't touch Tailscale serve config for 443.

## Conventions
- TypeScript, ESM, Node 24, strict. Shared zod schemas + error codes live in `packages/shared`; import them,
  don't redefine. Agent-facing errors always use a code from `packages/shared/src/errors.ts`.
- Tests: Vitest. Desktop e2e tests assert the effect inside the desktop, not just the tool response.
- Commit small, working steps with clear messages. Don't commit `node_modules`/`dist`.
