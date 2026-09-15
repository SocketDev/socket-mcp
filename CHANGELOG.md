# Changelog

All notable changes to `@socketsecurity/mcp` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0](https://github.com/SocketDev/socket-mcp/releases/tag/v0.2.0) - 2026-09-15

### Internal

- **`ci`** — normalize workflow labels

## [0.1.0](https://github.com/SocketDev/socket-mcp/releases/tag/v0.1.0) - 2026-09-14

### Added

- **`mcp`** — structured audit logging for MCP tool executions
- **`mcp`** — serve the stateless protocol on the v2 sdk

### Changed

- The copyable socket-gate hook directory in the published package moved from
  `hooks/socket-gate` to `dist/socket-gate`.

### Fixed

- **`telemetry`** — forward MCP client identity to Socket API
- **`build`** — omit dependency documentation from bundles
- **`tooling`** — keep debug client callbacks void
- **`tooling`** — classify the product entrypoint
- **`build`** — resolve current fleet entrypoint helpers
- **`oauth`** — reject tokens at expiration and verify reauthorization
- match Socket coverage badge styling
- **`server`** — refine artifact lookup and request checks
- **`fuzz`** — match .mts targets and stay quiet on an empty run
- **`workspace`** — drop pnpm settings current pnpm rejects
- **`docs`** — remove trailing space inside a code span
- **`origin`** — trust the hosted deployment's Host over a strict Origin allowlist (#214)
- **`mcp`** — use socket-lib isPlainObject in maskArgs
- **`readme`** — serve the four images from absolute raw URLs
- **`catalog`** — sync the sdk -stable alias to its base version
- **`catalog`** — sync the sdk -stable alias to the held base version
- **`soak`** — drop the unpublishable bare stuie exclude
- **`scripts`** — drop npm-run-all2 and the dead llms-txt script
- **`oauth`** — bind tokens to this resource server and harden discovery
- **`build`** — stop the clean step racing concurrent cache writers

### Internal

- **`ci`** — consolidate pins and collect offline server tests
- **`ci`** — read app client identifiers from secrets
- **`ci`** — use public app client identifiers
- **`ci`** — read payload client ids from secrets
- **`config`** — reconcile repository-owned files
- **`ci`** — use inline checkout bootstrap
- **`ci`** — align lockfile with hydrated catalogs
- **`bootstrap`** — await the newest fleet reference
- **`deps`** — restore the missing yaml catalog entry
- **`deps`** — drop the orphaned pnpm package-manager pin
- **`deps`** — restore the payload importer the lockfile dropped
- **`ci`** — keep the zizmor config tracked, it is not fleet payload
- **`lint`** — escape raw NULs and hoist bypass markers

## [0.0.20]

### Fixed

- OAuth-enabled HTTP deployments now accept `sktsec_` Socket API tokens sent
  via `Authorization: Bearer <token>`.

## [0.0.19]

### Changed

- Organization tools now scope their results to the authenticated caller.

### Fixed

- Composer package URLs parse correctly: `packagist` is accepted as a composer
  alias, bare-name packages resolve, and the vendor namespace is split from the
  package name.
- The `depscore` tool no longer errors on packages with missing or non-numeric
  score data.
- The HTTP server limits the size of POST request bodies.
- OAuth tokens whose introspection response carries a malformed expiry are now
  rejected.

## [0.0.18]

### Fixed

- The `package_files` and `organizations` tools no longer fail with
  `Unexpected token` JSON errors against the live Socket API.

## [0.0.17]

Initial tracked release.
