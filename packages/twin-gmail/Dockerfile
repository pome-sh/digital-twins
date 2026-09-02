# Build context is the monorepo root so npm ci uses the committed workspace lock.
FROM node:26.8.1-bookworm@sha256:9f94d34c787165dca03b74e5bf9c3bf90e8de79b19aa3d87fe1fa1694bf75c89 AS build
WORKDIR /repo
COPY package.json package-lock.json ./
# `cli/` is a workspace member (its manifest is in the lockfile), so npm ci
# needs the manifest present even though no twin image runs the CLI.
COPY cli/package.json cli/package.json
COPY packages packages
# Scope the install to the workspaces this image actually builds: the twin,
# plus sdk/wire it compiles against, plus the workspace root's own
# devDependencies. Without the scope, npm ci would also pull the CLI's
# @ai-sdk/ai/anthropic graph into a build stage that never uses it.
RUN npm ci --include-workspace-root \
  -w @pome-sh/wire -w @pome-sh/sdk -w @pome-sh/twin-gmail
RUN npm run build -w @pome-sh/wire
RUN npm run build -w @pome-sh/sdk
RUN npm run build -w @pome-sh/twin-gmail
RUN rm -rf node_modules packages/*/node_modules \
  && npm ci --omit=dev -w @pome-sh/twin-gmail

FROM node:26.8.1-trixie-slim@sha256:c0753125a3789977aefe869cbebccf70e3cfd7ea84ca48547458f02e4f1d7146 AS runtime
WORKDIR /repo
ENV NODE_ENV=production
ENV GMAIL_TWIN_HOST=0.0.0.0
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
# Take Debian's published security fixes on top of the pinned digest. The digest
# freezes this image's package contents while Trivy's vulnerability DB refreshes
# on every run, so a fix Debian ships BEFORE upstream rebuilds the
# node:*-trixie-slim tag lands as a FIXABLE HIGH on frozen contents, and the
# publish gate then refuses this image identically on every future run — not a
# flake, and a re-run cannot clear it. The pin still fixes where the image
# STARTS; this layer lets a rebuild move.
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /repo/node_modules ./node_modules
# The twin's dist imports @pome-sh/wire; ship its built output — package.json
# plus dist is the entire runtime need.
COPY --from=build /repo/packages/wire/package.json ./packages/wire/package.json
COPY --from=build /repo/packages/wire/dist ./packages/wire/dist
COPY --from=build /repo/packages/sdk/package.json ./packages/sdk/package.json
COPY --from=build /repo/packages/sdk/dist ./packages/sdk/dist
COPY --from=build /repo/packages/twin-gmail/package.json ./packages/twin-gmail/package.json
COPY --from=build /repo/packages/twin-gmail/dist ./packages/twin-gmail/dist
ARG GIT_SHA=dev
ARG BUILD_TIME=dev
ENV POME_TWIN_GIT_SHA=$GIT_SHA
ENV POME_TWIN_BUILD_TIME=$BUILD_TIME
EXPOSE 3336
CMD ["node", "packages/twin-gmail/dist/src/server.js"]
