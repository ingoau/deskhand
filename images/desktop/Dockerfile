# syntax=docker/dockerfile:1.7
# deskhand desktop image: Xvfb + openbox + tint2 + apps + the control daemon.
# Build from the repo root:  docker build -f images/desktop/Dockerfile -t deskhand-desktop:dev .
# Multi-arch (amd64, arm64): every package below exists for both in Debian.

ARG DEBIAN_RELEASE=trixie

FROM node:24-${DEBIAN_RELEASE}-slim AS node

# ---------------------------------------------------------------- package manifests only (for layer caching)
FROM node AS manifests
WORKDIR /src
COPY . .
RUN find . -mindepth 1 \( -name node_modules -prune \) -o \( -type f ! -name package.json ! -name pnpm-lock.yaml ! -name pnpm-workspace.yaml -print \) | xargs -r rm -f \
 && find . -depth -type d -empty -delete

# ---------------------------------------------------------------- build the daemon bundle
FROM node AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1
RUN corepack enable
WORKDIR /src
COPY --from=manifests /src/ ./
RUN pnpm install --frozen-lockfile --filter "@deskhand/daemon..."
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/daemon packages/daemon
RUN pnpm --filter @deskhand/shared build && pnpm --filter @deskhand/daemon bundle
# Runtime dir: the bundle plus sharp (native, per-arch) installed with npm.
RUN mkdir -p /out \
 && cp packages/daemon/dist/bundle/daemon.mjs packages/daemon/dist/bundle/daemon.mjs.map /out/ \
 && SHARP_VERSION="$(node -p "require('./packages/daemon/node_modules/sharp/package.json').version")" \
 && cd /out && printf '{"name":"deskhand-daemon-runtime","private":true,"type":"module"}\n' > package.json \
 && npm install --omit=dev --no-audit --no-fund --no-package-lock "sharp@${SHARP_VERSION}" \
 && rm package.json

# ---------------------------------------------------------------- the desktop
FROM debian:${DEBIAN_RELEASE}-slim
ARG DESKHAND_VERSION=0.1.0
LABEL org.opencontainers.image.title="deskhand-desktop" \
      org.opencontainers.image.source="https://github.com/deskhand/deskhand" \
      org.opencontainers.image.licenses="Apache-2.0" \
      deskhand.kind="desktop-image"

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    TZ=UTC

# Desktop, apps, fonts, accessibility, tools. No recommends, no LibreOffice.
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc openbox tint2 \
      x11-utils x11-xserver-utils xdotool xclip wmctrl xauth \
      chromium firefox-esr \
      pcmanfm mousepad ristretto featherpad xterm \
      adwaita-icon-theme gnome-themes-extra-data librsvg2-common shared-mime-info desktop-file-utils xdg-utils \
      fonts-noto-core fonts-noto-mono fonts-noto-cjk fonts-noto-color-emoji \
      supervisor dbus dbus-x11 at-spi2-core python3 python3-pyatspi gir1.2-atspi-2.0 \
      ca-certificates curl procps psmisc util-linux tzdata less \
 && apt-get clean && rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/* /var/cache/debconf/*-old

COPY --from=node /usr/local/bin/node /usr/local/bin/node

RUN groupadd -g 1000 agent && useradd -m -u 1000 -g 1000 -s /bin/bash agent \
 && mkdir -p /home/agent/Desktop /home/agent/Downloads /home/agent/Documents \
 && chown -R agent:agent /home/agent

COPY images/desktop/rootfs/ /
COPY images/desktop/chrome-seccomp.json /opt/deskhand/chrome-seccomp.json
COPY --from=build /out/ /opt/deskhand/daemon/
COPY packages/daemon/helpers/uitree.py /opt/deskhand/uitree.py

RUN chmod 0755 /usr/local/bin/deskhand-* /usr/local/lib/deskhand/* \
 && ln -sf /usr/local/bin/deskhand-chromium /usr/local/bin/chromium \
 && sed -i -e 's|<number>4</number>|<number>1</number>|' -e '\|/var/lib/openbox/debian-menu.xml|d' /etc/xdg/openbox/rc.xml \
 && update-alternatives --install /usr/bin/x-www-browser x-www-browser /usr/local/bin/deskhand-chromium 300 \
 && update-desktop-database /usr/local/share/applications \
 && /usr/local/lib/deskhand/gen-versions "${DESKHAND_VERSION}" > /etc/deskhand-versions.json \
 && cat /etc/deskhand-versions.json

EXPOSE 7000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:7000/health >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/deskhand-entrypoint"]
