# Multi-stage build for socket-mcp.
#
# Build stage: install deps, run rolldown bundle, produce `dist/index.cjs`.
# Runtime stage: copy only the bundled artifact onto a minimal Node base.
#
# socket-mcp bundles all production deps into `dist/index.cjs` via rolldown
# (see package.json `bundleDependencies` + the build:* scripts). The runtime
# image therefore needs zero `node_modules` and zero `package.json` — just
# the single self-contained `dist/index.cjs` with its `#!/usr/bin/env node`
# shebang. This produces an image ~30 MB (alpine + node + 1 file) instead of
# the ~250 MB the previous single-stage Dockerfile shipped (full node_modules
# + repo source).

# ─── Build stage ────────────────────────────────────────────────────────────
FROM node:lts-alpine AS build

WORKDIR /usr/src/app

# Enable corepack so the pinned pnpm version (from package.json
# packageManager field) resolves automatically — no global install drift.
RUN corepack enable

# Copy lockfile + workspace config first so the dep layer caches when only
# source changes. `pnpm install --frozen-lockfile` fails CI-style if the
# lockfile is stale, which is what we want for reproducible builds.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY .claude/hooks ./.claude/hooks

RUN pnpm install --frozen-lockfile --ignore-scripts

# Copy source needed by the build. The build runs scripts/build.mts
# (rolldown bundler) + tsgo for .d.ts emission + chmod on the output.
COPY index.ts ./
COPY lib ./lib
COPY scripts ./scripts
COPY tsconfig.json tsconfig.dts.json ./

RUN pnpm run build

# ─── Runtime stage ──────────────────────────────────────────────────────────
FROM node:lts-alpine AS runtime

WORKDIR /usr/src/app

# Copy ONLY the bundled artifact. dist/index.cjs is fully self-contained
# (rolldown inlines every dep) so no node_modules or package.json needs to
# travel to the runtime layer.
COPY --from=build /usr/src/app/dist/index.cjs ./dist/index.cjs

# Drop privileges — the base image ships a `node` user (uid 1000).
USER node

ENV MCP_PORT="3000"
EXPOSE 3000

# Use `node` directly on the bundle. The bundle's shebang would let
# `./dist/index.cjs --http` also work, but `node <file>` is more explicit
# for Docker readers and skips the chmod-x dance.
CMD ["node", "dist/index.cjs", "--http"]
