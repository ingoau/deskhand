# syntax=docker/dockerfile:1.7
# deskhand manager image: manager (API, MCP at /mcp, dashboard static files) + the `deskhand` CLI.
# Build from the repo root:  docker build -f images/deskhand/Dockerfile -t deskhand:dev .
# (images/deskhand/Dockerfile.dockerignore keeps the context small.) Multi-arch: amd64, arm64.

ARG DEBIAN_RELEASE=trixie

# Full node image for building: native modules (better-sqlite3, sharp) fall back to compiling if no prebuild fits.
FROM node:24-${DEBIAN_RELEASE} AS build-base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1
RUN corepack enable

# ---------------------------------------------------------------- package manifests only (for layer caching)
FROM build-base AS manifests
WORKDIR /src
COPY . .
RUN find . -mindepth 1 \( -name node_modules -prune \) -o \( -type f ! -name package.json ! -name pnpm-lock.yaml ! -name pnpm-workspace.yaml -print \) | xargs -r rm -f \
 && find . -depth -type d -empty -delete

# ---------------------------------------------------------------- build manager, mcp, cli, dashboard
FROM build-base AS build
WORKDIR /src
COPY --from=manifests /src/ ./
RUN pnpm install --frozen-lockfile --filter "@deskhand/manager..." --filter "@deskhand/cli..." --filter "@deskhand/dashboard..."
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/mcp packages/mcp
COPY packages/manager packages/manager
COPY packages/cli packages/cli
COPY packages/dashboard packages/dashboard
RUN pnpm --filter "@deskhand/manager..." --filter "@deskhand/cli..." --filter "@deskhand/dashboard" run build
# Production node_modules only, then assemble /out/app with the workspace layout (pnpm's symlinks are relative).
RUN rm -rf node_modules packages/*/node_modules \
 && pnpm install --frozen-lockfile --prod --filter "@deskhand/manager..." --filter "@deskhand/cli..." \
 && mkdir -p /out/app/packages/dashboard \
 && cp -a package.json node_modules /out/app/ \
 && for p in shared mcp manager cli; do \
      mkdir -p /out/app/packages/$p && cp -a packages/$p/package.json packages/$p/dist /out/app/packages/$p/ \
      && if [ -d packages/$p/node_modules ]; then cp -a packages/$p/node_modules /out/app/packages/$p/; fi; \
    done \
 && cp -a packages/dashboard/dist /out/app/packages/dashboard/dist \
 && find /out/app -name '*.map' -delete \
 && node -e "require('/out/app/packages/manager/node_modules/better-sqlite3'); console.log('better-sqlite3 ok')"

# ---------------------------------------------------------------- runtime
FROM node:24-${DEBIAN_RELEASE}-slim
LABEL org.opencontainers.image.title="deskhand" \
      org.opencontainers.image.description="deskhand manager: API, MCP server, dashboard and CLI" \
      org.opencontainers.image.source="https://github.com/ingoau/deskhand" \
      org.opencontainers.image.licenses="Apache-2.0"

ENV NODE_ENV=production \
    DESKHAND_LISTEN=0.0.0.0:7480 \
    DESKHAND_DATA_DIR=/data \
    DESKHAND_DASHBOARD_DIR=/opt/deskhand/app/packages/dashboard/dist \
    DESKHAND_SECCOMP_PROFILE=/opt/deskhand/chrome-seccomp.json

COPY --from=build /out/ /opt/deskhand/
# Chrome's seccomp profile: the manager sends its JSON text in SecurityOpt when it creates a desktop.
COPY images/desktop/chrome-seccomp.json /opt/deskhand/chrome-seccomp.json
COPY images/deskhand/rootfs/ /

# The manager runs as `node` (uid 1000, from the base image); the entrypoint (root) adds the Docker
# socket's group at runtime and drops privileges. `docker compose exec deskhand deskhand …` runs as root
# and reads the admin credential from /data/admin.json.
RUN chmod 0755 /usr/local/bin/deskhand /usr/local/bin/deskhand-entrypoint \
 && mkdir -p /data && chown node:node /data

VOLUME /data
EXPOSE 7480
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "/opt/deskhand/healthcheck.mjs"]
ENTRYPOINT ["/usr/local/bin/deskhand-entrypoint"]
CMD ["node", "/opt/deskhand/app/packages/manager/dist/main.js"]
