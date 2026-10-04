FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS build
WORKDIR /opt/omw
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN node scripts/worker/prepare-build.mjs && npm ci --no-audit --no-fund && npm run build

FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS acp
WORKDIR /build/acp
COPY deploy/worker/acp ./
RUN npm ci --no-audit --no-fund && npm run build \
    && npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS toolchain
ARG OPENCODE_VERSION=1.18.34
LABEL org.opencontainers.image.title="OMW Worker" \
      io.omw.opencode.version="1.18.34"
# Linux execution namespace 僅供 OpenCode 與其工具；沒有 Docker socket 或 host credentials。
COPY deploy/worker /opt/omw/deploy/worker
RUN node /opt/omw/deploy/worker/toolchain-install.mjs \
    && test "$OPENCODE_VERSION" = "1.18.34" \
    && npm install -g "opencode-ai@$OPENCODE_VERSION" --no-audit --no-fund \
    && test "$(opencode --version)" = "$OPENCODE_VERSION" \
    && install -d -o node -g node /data/manager /workspace /home/node/.local /home/node/.local/share /home/node/.local/state /home/node/.config /home/node/.cache
WORKDIR /opt/omw
COPY scripts/worker/toolchain-smoke.mjs /opt/omw/scripts/worker/toolchain-smoke.mjs
ENV HOME=/home/node \
    XDG_DATA_HOME=/home/node/.local/share \
    XDG_STATE_HOME=/home/node/.local/state \
    XDG_CONFIG_HOME=/home/node/.config \
    XDG_CACHE_HOME=/home/node/.cache \
    JAVA_HOME=/opt/omw-worker/toolchain/java \
    MAVEN_HOME=/opt/omw-worker/toolchain/maven \
    PATH=/opt/omw-worker/toolchain/java/bin:/opt/omw-worker/toolchain/maven/bin:/opt/omw-worker/toolchain/gh/bin:${PATH} \
    OFFICECLI_SKIP_UPDATE=1 \
    OFFICECLI_NO_AUTO_INSTALL=1 \
    OFFICECLI_NO_AUTO_RESIDENT=1
USER node

FROM toolchain AS worker
COPY --from=build /opt/omw /opt/omw
COPY --from=acp /build/acp/dist/ /opt/omw-worker/acp/
COPY --from=acp /build/acp/package.json /build/acp/package-lock.json /opt/omw-worker/acp/
COPY --from=acp /build/acp/node_modules/ /opt/omw-worker/acp/node_modules/
USER root
RUN chmod -R a-w /opt/omw-worker/acp
USER node
ENV OMW_WEB_ROOT=/opt/omw/apps/web/dist \
    OMW_WORKER_PROFILE_SOURCE=/opt/omw/deploy/worker/profile \
    OMW_WORKER_PROFILE_DIR=/home/node/.config/omw-profile \
    OMW_WORKER_DEPENDENCIES_SOURCE=/opt/omw-worker/acp \
    OPENCODE_CONFIG=/home/node/.config/omw-profile/opencode.json \
    OPENCODE_CONFIG_DIR=/home/node/.config/omw-profile
CMD ["node", "apps/manager/dist/src/server.js"]
