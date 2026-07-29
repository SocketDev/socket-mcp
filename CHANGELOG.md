# Changelog

All notable changes to `@socketsecurity/mcp` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The copyable socket-gate hook directory in the published package moved from
  `hooks/socket-gate` to `dist/socket-gate`.

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
