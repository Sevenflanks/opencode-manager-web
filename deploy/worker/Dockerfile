FROM node:24.14.0-bookworm-slim AS build
WORKDIR /opt/omw
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN node scripts/worker/prepare-build.mjs && npm ci --no-audit --no-fund && npm run build

FROM node:24.14.0-bookworm-slim
ARG OPENCODE_VERSION=1.18.34
LABEL org.opencontainers.image.title="OMW Worker" \
      io.omw.opencode.version="1.18.34"
# Linux execution namespace 僅供 OpenCode 與其工具；沒有 Docker socket 或 host credentials。
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git bash curl openssh-client ripgrep jq unzip procps \
    && rm -rf /var/lib/apt/lists/* \
    && test "$OPENCODE_VERSION" = "1.18.34" \
    && npm install -g "opencode-ai@$OPENCODE_VERSION" --no-audit --no-fund \
    && test "$(opencode --version)" = "$OPENCODE_VERSION" \
    && install -d -o node -g node /data/manager /workspace /home/node/.local /home/node/.local/share /home/node/.local/state /home/node/.config /home/node/.cache
WORKDIR /opt/omw
COPY --from=build /opt/omw /opt/omw
ENV HOME=/home/node \
    XDG_DATA_HOME=/home/node/.local/share \
    XDG_STATE_HOME=/home/node/.local/state \
    XDG_CONFIG_HOME=/home/node/.config \
    XDG_CACHE_HOME=/home/node/.cache \
    OMW_WEB_ROOT=/opt/omw/apps/web/dist
USER node
CMD ["node", "apps/manager/dist/src/server.js"]
