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
#
# Alignment with socket-btm/Dockerfile.local-dev: btm pulls pnpm via
# socket-registry's `.build-context/registry-tools.json` (SHA-verified,
# materialized by socket-registry's setup-and-install action in CI). That
# pattern requires the CI infrastructure that exports
# SOCKET_TOOL_CHECKSUMS_FILE; mcp's Dockerfile is also user-runnable from a
# clean clone, so it uses corepack to resolve pnpm from package.json's
# `packageManager` field. Same intent (pinned, reproducible), different
# delivery (CI-side SHA gate vs. corepack signature).

# ─── Build stage ────────────────────────────────────────────────────────────
FROM node:lts-alpine AS build

WORKDIR /usr/src/app

# Resolve pnpm via corepack from the `packageManager` field in package.json.
# corepack downloads + verifies the pnpm tarball against the SHA embedded in
# `packageManager: "pnpm@X.Y.Z+sha512.<hex>"` (or against npm registry
# signatures when the +sha suffix is absent). This is the user-runnable
# equivalent of btm's `SHA-verify-then-extract` pnpm install pattern.
RUN corepack enable

# Copy lockfile + workspace config first so the dep layer caches when only
# source changes. `--frozen-lockfile` fails CI-style if the lockfile is
# stale, which is what we want for reproducible builds. `--ignore-scripts`
# blocks lifecycle hooks (postinstall, prepare) which would try to run
# `install-git-hooks.mts` inside the image where there is no `.git`.
# `--prefer-offline` favors the pnpm store cache when present.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN pnpm install --frozen-lockfile --ignore-scripts --prefer-offline

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
