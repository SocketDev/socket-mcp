# Changelog

All notable changes to `@socketsecurity/mcp` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0](https://github.com/SocketDev/socket-mcp/releases/tag/v0.4.0) - 2026-11-12

- Add validation and packaging for ChatGPT uploads (#229) (371fd53)
- Send a bare Bearer challenge when OAuth requests have no credentials (#230) (dee2454)
- Serve the OpenAI Apps domain verification challenge (#228) (dd0454f)
- Remove the retired release baseline (e1fb803)
- Run repository type checks and the package build in CI (591899f)
- Disable remote caching during npm publication (9df1d89)
- Preserve the verified trust bundle in CI setup (a1753af)

## [0.2.1](https://github.com/SocketDev/socket-mcp/releases/tag/v0.2.1) - 2026-09-17

### Fixed

- Show one Socket logo in the README and use text links for VS Code and Cursor installation.

## [0.2.0](https://github.com/SocketDev/socket-mcp/releases/tag/v0.2.0) - 2026-09-15

## [0.1.0](https://github.com/SocketDev/socket-mcp/releases/tag/v0.1.0) - 2026-09-14

### Features

- **`mcp`** — structured audit logging for MCP tool executions
- **`mcp`** — serve the stateless protocol with SDK v2

### Fixes

- **`telemetry`** — forward MCP client identity to Socket API
- **`build`** — exclude dependency documentation from bundles
- **`tooling`** — keep debug-client callbacks void
- **`tooling`** — identify the product entry point
- **`build`** — resolve the current fleet entry-point helpers
- **`oauth`** — reject expired tokens and verify reauthorization
- **`server`** — improve artifact lookup and request validation
- **`fuzz`** — find `.mts` targets and stay quiet when no targets match
- **`origin`** — trust the hosted deployment's Host over a strict Origin allowlist (#214)
- **`mcp`** — use Socket Lib's `isPlainObject` in `maskArgs`
- **`oauth`** — bind tokens to this resource server and strengthen discovery

## [0.0.20]

### Fixed

- OAuth-enabled HTTP deployments now accept `sktsec_` Socket API tokens sent
  in the `Authorization: Bearer <token>` header.

## [0.0.19]

### Features

- Organization tools now scope their results to the authenticated caller.

### Fixes

- Composer package URLs parse correctly: `packagist` is accepted as a composer
  alias, bare-name packages resolve, and the vendor namespace is split from the
  package name.
- The `depscore` tool no longer errors on packages with missing or non-numeric
  score data.
- The HTTP server limits the size of POST request bodies.
- OAuth tokens whose introspection response carries a malformed expiry are now
  rejected.

## [0.0.18]

### Fixes

- The `package_files` and `organizations` tools no longer fail with
  `Unexpected token` JSON errors against the live Socket API.

## [0.0.17]

Initial tracked release.
