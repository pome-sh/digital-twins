# Build context is the monorepo root. This lets the image use the committed
# workspace lockfile with npm ci instead of resolving dependencies from a
# standalone package context.
FROM node:24-bookworm@sha256:c35698d36238c69451c7e7a5951dd5c9b11c3e45884c918059c94c4a8be969b1 AS build
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
  -w @pome-sh/wire -w @pome-sh/sdk -w @pome-sh/twin-stripe
RUN npm run build -w @pome-sh/wire
# The twin imports `@pome-sh/sdk/server`, resolved from the SDK's built dist.
RUN npm run build -w @pome-sh/sdk
RUN npm run build -w @pome-sh/twin-stripe
# The runtime image should not include dev/test tooling or unrelated workspace
# deps. Reinstall only this twin's production graph (plus workspace deps it
# links: sdk, wire) — not every packages/* workspace.
RUN rm -rf node_modules packages/*/node_modules \
  && npm ci --omit=dev -w @pome-sh/twin-stripe

FROM node:24-trixie-slim@sha256:9022946fb57e6fb6a2503931470deba4b49db02bfc8f587f93007fd33ef54415 AS runtime
WORKDIR /repo
ENV NODE_ENV=production
ENV STRIPE_CLONE_HOST=0.0.0.0
# Runtime only executes `node`; npm/npx from the base image add unused packages
# (and their CVE surface) to the scanned image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=build /repo/node_modules ./node_modules
# The twin's dist imports @pome-sh/wire; ship its built output. Before F-942 this
# was `COPY packages/shared-types` -- the WHOLE directory, sources included -- because
# that package exported `./src/index.ts` and `build:runtime` emitted the runtime
# `.js` in place beside each `.ts`. wire builds to dist/ like every other
# package, so package.json + dist is the entire runtime need.
COPY --from=build /repo/packages/wire/package.json ./packages/wire/package.json
COPY --from=build /repo/packages/wire/dist ./packages/wire/dist
# The twin's dist imports `@pome-sh/sdk`; ship the SDK's built output so the
# workspace symlink in node_modules resolves at runtime.
COPY --from=build /repo/packages/sdk/package.json ./packages/sdk/package.json
COPY --from=build /repo/packages/sdk/dist ./packages/sdk/dist
COPY --from=build /repo/packages/twin-stripe/package.json ./packages/twin-stripe/package.json
COPY --from=build /repo/packages/twin-stripe/dist ./packages/twin-stripe/dist
# Bake build provenance into the /healthz `runtime` block (read by the sdk's
# build-info env surface). CI passes the real values; local builds keep the
# "dev" markers. Placed after the COPY layers so a new SHA never invalidates
# the copied-artifact cache.
ARG GIT_SHA=dev
ARG BUILD_TIME=dev
ENV POME_TWIN_GIT_SHA=$GIT_SHA
ENV POME_TWIN_BUILD_TIME=$BUILD_TIME
EXPOSE 3333
CMD ["node", "packages/twin-stripe/dist/src/server.js"]
