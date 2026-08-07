# Debugging with the mock clients

Three debug clients in `mock-client/` drive a real Socket MCP server so you can
see the wire traffic without wiring up Claude Desktop or Cursor. Use them to
answer "is the server broken, or is my client broken?".

For the bare run commands, see [`mock-client/README.md`](../mock-client/README.md).
This page covers what the output means and what to do when it looks wrong.

## Before you start

You need Node 24 or later (`package.json` sets `engines.node` to `>=24`) and a
Socket API token:

```bash
node --version
# v24.0.0 or higher

export SOCKET_API_TOKEN="your-socket-api-token"
```

Get a token from the [Socket dashboard](https://socket.dev/) under API tokens.
Only the `packages:list` scope is needed for `depscore`.

`mock-client/debug-client.ts` reads `SOCKET_API_TOKEN` and nothing else, so the
aliases the server itself accepts (`SOCKET_API_KEY`, `SOCKET_CLI_API_TOKEN`, and
friends) will not satisfy it. Export `SOCKET_API_TOKEN` specifically.

No build step is needed. Every client spawns `index.ts` directly and Node 24
strips the types.

## Which client to reach for

| Client            | Command                | What it proves                                                          |
| ----------------- | ---------------------- | ----------------------------------------------------------------------- |
| `debug-client.ts` | `pnpm run debug-stdio` | The legacy 2025 handshake still works: raw hand-written JSON-RPC frames |
| `stdio-client.ts` | `pnpm run debug-sdk`   | A real SDK client can talk to the server over stdio                     |
| `http-client.ts`  | `pnpm run debug-http`  | A real SDK client can talk to the server over Streamable HTTP           |

The two SDK clients connect with `versionNegotiation: { mode: 'auto' }`, which
probes for `server/discover` first and falls back to the 2025 `initialize`
handshake. Each prints the era it landed on.

## What a healthy run looks like

`pnpm run debug-sdk`:

```text
Using server script: /path/to/socket-mcp/index.ts
ℹ Connected to MCP server
ℹ Protocol era: modern
ℹ Negotiated protocol version: 2026-07-28
ℹ Available tools: [
  'depscore',
  'organizations',
  'alerts',
  'threat_feed',
  'package_files',
  'package_file_contents',
  'package_file_grep'
]
```

`Protocol era: modern` with version `2026-07-28` is the expected result.
`Protocol era: legacy` means the SDK fell back, which points at a stale server
build rather than a client problem.

The `depscore` result is one text block. Scores are integers from 0 to 100 and
the keys come back alphabetically:

```text
Dependency scores:
pkg:npm/express@4.18.2: license: 100, maintenance: 87, quality: 100, supplyChain: 97, vulnerability: 98
  Report: https://socket.dev/npm/package/express
pkg:pypi/requests@2.31.0: license: 100, maintenance: 100, quality: 100, supplyChain: 99, vulnerability: 97
  Report: https://socket.dev/pypi/package/requests
```

Packages come back in the order the API returns them, not the order you asked
for, and a package Socket has never seen is absent from the list.

## HTTP mode

The stdio clients spawn the server themselves. The HTTP client does not, so
start one first:

```bash
pnpm run server-http
```

Then, in a second terminal:

```bash
pnpm run debug-http
```

Both honor a custom port:

```bash
MCP_PORT=3901 pnpm run server-http
MCP_URL="http://localhost:3901" pnpm run debug-http
```

The HTTP transport is stateless. There is no session to open or close, no
`Mcp-Session-Id` header, and nothing to reap. Every POST is self-contained, so
you can replay a single request in isolation and get the same answer.

<details>

<summary>Poking the endpoint by hand</summary>

The MCP endpoint is `POST /`:

```bash
curl -sS http://localhost:3000/ \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The spec wants both content types in `Accept`. The server rewrites a missing or
partial `Accept` header before the MCP handler sees it, so a bare `curl` also
works, but a real client should send both.

The response is a Server-Sent Events stream, so the JSON arrives on a `data: `
line rather than as a bare body.

Sending an `Origin` header that does not name this server gets a `403`. Omitting
`Origin` entirely, as `curl` does by default, is allowed.

The health endpoint is plain JSON and skips origin validation, which makes it
the right target for a container probe:

```bash
curl -sS http://localhost:3000/health
```

```json
{
  "status": "healthy",
  "service": "socket-mcp",
  "version": "0.0.20",
  "timestamp": "2026-07-29T01:50:30.394Z"
}
```

</details>

## Reading errors

A tool that fails does not return a JSON-RPC `error`. It returns a normal
result whose content carries the message and `isError: true`:

```json
{
  "content": [{ "type": "text", "text": "No packages were found." }],
  "isError": true
}
```

An unknown tool name comes back the same way (`Unknown tool: <name>`), so check
`isError` on every result rather than only catching thrown errors.

A JSON-RPC `error` object means the failure happened below the tool layer:

| Symptom                     | HTTP  | JSON-RPC code | Cause                                           |
| --------------------------- | ----- | ------------- | ----------------------------------------------- |
| `Parse error`               | `400` | `-32700`      | The request body is not valid JSON              |
| `Method not found`          | `200` | `-32601`      | The method name is not one the server serves    |
| `Request body too large`    | `413` | `-32600`      | The body exceeded the 4 MB cap                  |
| `Method not allowed.`       | `405` | `-32000`      | `GET` or `DELETE` on the MCP endpoint           |
| `Forbidden: Invalid origin` | `403` | `-32000`      | The `Origin` or `Host` header failed validation |

## Troubleshooting

**`SOCKET_API_TOKEN environment variable is required`** - the stdio server
refuses to start without a token. Export one, or use the aliases the server
accepts (`SOCKET_API_KEY`, `SOCKET_CLI_API_TOKEN`, `SOCKET_CLI_API_KEY`,
`SOCKET_SECURITY_API_TOKEN`, `SOCKET_SECURITY_API_KEY`). The debug clients
themselves only read `SOCKET_API_TOKEN`.

**`Authentication is required.` from `organizations` / `alerts` /
`threat_feed` / `package_files`** - these tools are org-scoped and never fall
back to a shared deploy key. Over HTTP, send your own token as
`Authorization: Bearer <token>`.

**The HTTP client gets a 404** - the MCP endpoint is `/`, so drop any trailing
path and any trailing slash from `MCP_URL`. Confirm the server came up in HTTP
mode; `pnpm run server-http` prints `Connect to: http://localhost:3000/`.

**Connection refused** - nothing is listening. Check the port matches between
`MCP_PORT` and `MCP_URL`.

**The stdio client hangs** - Ctrl+C. Make sure `MCP_HTTP_MODE` is not exported
in your shell; it would put the spawned server into HTTP mode, where it never
reads stdin.

**You want to see every request** - set `SOCKET_DEBUG=1`. The server logs
request and cache traces, and there is a script for it:

```bash
pnpm run server-http:debug
pnpm run server-stdio:debug
```

All server output goes to stderr. Nothing is written to a log file, because
stdout belongs to the JSON-RPC framing.

**You want to point at a local Socket API** - set `SOCKET_API_BASE_URL`. Setting
`SOCKET_DEBUG=1` alone also switches `depscore`'s default upstream to
`http://localhost:8866`.

## Testing other packages

Each client hard-codes its sample packages. Edit the array in the client you are
running (`mock-client/debug-client.ts`, `mock-client/stdio-client.ts`, or
`mock-client/http-client.ts`) to try your own.
