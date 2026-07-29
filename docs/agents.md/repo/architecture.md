# socket-mcp architecture

Detail extracted from `CLAUDE.md` to keep the in-context file under the 40 KB cap.

socket-mcp is the Socket Model Context Protocol server. It exposes Socket dependency scanning and Socket.dev API surfaces to MCP-aware clients (Claude Desktop, Claude Code, Cursor, VS Code Copilot).

## Layout

- `index.ts` — CLI entry. Resolves the transport (stdio or HTTP), resolves the API token, wires OAuth, then hands `createConfiguredServer` to `serveStdio` or `startHttpServer`. It registers no tools itself.
- `lib/server.ts` — the server factory. `buildToolSpecs()` collects every tool spec and `createConfiguredServer()` returns a fresh low-level `Server` with the `tools/list` and `tools/call` handlers bound.
- `lib/tool-*.ts` — one module per tool: the TypeBox input schema, the description, and the handler, co-located.
- `lib/http-server.ts` — HTTP transport: routing, the 4 MB post-body cap, and the per-request auth handoff.
- `lib/http-origin.ts` — Origin/Host/Accept validation and CORS headers.
- `lib/oauth-config.ts` — env-derived OAuth settings and the per-config discovery cache.
- `lib/oauth-discovery.ts` — RFC 8414 authorization-server metadata discovery.
- `lib/oauth.ts` — the request-time bearer pipeline plus the RFC 9728 protected-resource metadata this server publishes.
- `lib/env.ts` — every env read in the server goes through a getter here.
- `test/` — split into `unit/`, `integration/`, `e2e/`, and `fleet/`. Not co-located with `lib/`.
- `mock-client/` — three debug clients that drive a real server. See [mock-client debugging](../../mock-client-debugging.md).

## SDK packages

The server targets MCP spec revision `2026-07-28` on the v2 split packages:

| Package                        | Used for                                              |
| ------------------------------ | ----------------------------------------------------- |
| `@modelcontextprotocol/server` | `Server`, `createMcpHandler`, `serveStdio` re-exports |
| `@modelcontextprotocol/node`   | `toNodeHandler` — adapts the handler to `node:http`   |
| `@modelcontextprotocol/client` | the debug clients in `mock-client/`                   |
| `@modelcontextprotocol/core`   | shared protocol types                                 |

Both transports take the server FACTORY, not an instance: `serveStdio` and `createMcpHandler` each build and close their own `Server` per exchange. Every call to `createConfiguredServer()` must return a fresh instance.

## Protocol

The protocol is stateless. There is no `initialize`/`initialized` handshake to track, no `Mcp-Session-Id`, and no session table. Both transports leave the SDK's `legacy` posture at its default, so 2025-era clients that do send `initialize` are still served.

- `tools/list` carries a one-hour public cache hint (`ttlMs: 3600000`, `cacheScope: 'public'`), set via the `cacheHints` option in `lib/server.ts`.
- On the HTTP endpoint, `GET` and `DELETE` reach the MCP handler and get its native `405`.
- A malformed request body answers `400` with JSON-RPC code `-32700`.
- A body over 4 MB answers `413` with code `-32600`.

## Tools

Registered in `lib/server.ts` (`buildToolSpecs`); the user-facing reference lives in `README.md` under "Tools exposed".

- `depscore` — dependency scores. Resolves its token with `resolveAuthToken`, which falls back to the boot-time static key because package scores are the same for every caller.
- `organizations` / `alerts` / `threat_feed` / `package_files` — org-scoped Socket REST API. These resolve with `resolveScopedAuthToken`, which refuses the static key when it belongs to a shared HTTP deploy, so a caller never gets the operator's org data.
- `package_file_contents` / `package_file_grep` — read and grep a blob by the hash `package_files` printed. Blobs are cached process-wide in `lib/blob-cache.ts`.

## Commands

| Task          | Command                                       |
| ------------- | --------------------------------------------- |
| Install       | `pnpm install`                                |
| Type check    | `pnpm run type`                               |
| Test          | `pnpm test`                                   |
| Test one file | `pnpm test test/unit/purl.test.mts`           |
| Lint / format | `pnpm run lint` / `pnpm run format`           |
| Check / fix   | `pnpm run check --all` / `pnpm run fix --all` |
| Build         | `pnpm run build`                              |
| Run stdio     | `pnpm run server-stdio`                       |
| Run HTTP      | `pnpm run server-http`                        |

`pnpm run build` bundles `index.ts` to `dist/index.cjs` and the Claude Code hook to `dist/socket-gate/`. Running from source needs no build: Node 24 strips the types itself, so `node index.ts` works.

## MCP-specific notes

- The stdio transport is framed JSON-RPC on stdout. Anything else written to stdout corrupts the frame, so diagnostics go to stderr via `logger` from `lib/logger.ts` (which wraps `getDefaultLogger()`), never `console.log`.
- Tool descriptions are part of the wire contract — changing one is a breaking change for clients that key on the description text. Bump the server version when modifying tool descriptions or input schemas.
- A container image must include a CA bundle (the base image's `ca-certificates`). The Socket API uses TLS and the server cannot prompt for a workaround at runtime.

## Testing

- Tests live under `test/` and are named `*.test.mts`, mirroring the module they cover (`lib/purl.ts` → `test/unit/purl.test.mts`).
- Never put `--` before a test path — the path stops being read as a positional and the run widens to the whole suite. Write `pnpm test test/unit/purl.test.mts`. The `no-vitest-double-dash-guard` hook blocks the `--` form.
- Mock the Socket API surface. The only suite allowed to reach the network is `test/e2e/`, run separately by `pnpm run test:e2e` and gated on a token.
