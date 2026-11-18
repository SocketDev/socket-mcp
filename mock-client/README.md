# Socket MCP Debug Clients

Three debug clients for exercising the Socket MCP server without a real MCP
host. Run every command from the repo root.

Deeper walkthrough, expected output, and error decoding:
[`docs/mock-client-debugging.md`](../docs/mock-client-debugging.md).

## Protocol eras

The clients split across the two MCP protocol eras so both stay covered:

| Client             | Script                 | Era                                                                              |
| ------------------ | ---------------------- | -------------------------------------------------------------------------------- |
| `debug-client.mts` | `pnpm run debug-stdio` | Legacy 2025 - raw JSON-RPC frames, `initialize` + `notifications/initialized`    |
| `stdio-client.mts` | `pnpm run debug-sdk`   | Modern - SDK client, `versionNegotiation: { mode: 'auto' }` over stdio           |
| `http-client.mts`  | `pnpm run debug-http`  | Modern - SDK client, `versionNegotiation: { mode: 'auto' }` over Streamable HTTP |

`mode: 'auto'` probes the server with `server/discover` and falls back to the
2025 `initialize` handshake when the server only speaks the legacy protocol.
Each SDK client prints the negotiated era and protocol version at connect.

## Quick start

### 1. Check your Node version

```bash
node --version
# v24.0.0 or higher
```

### 2. Sign in for stdio

Run the browser sign-in once:

```bash
node index.mts login
```

The stdio clients use the saved OAuth session. Set `SOCKET_API_TOKEN` only as a
fallback when browser sign-in is unavailable. HTTP mode without OAuth still
needs an API token in the server environment.

### 3. Start the MCP server

The stdio clients spawn the server themselves, so this step is only needed for
HTTP mode:

```bash
pnpm run server-http
```

**HTTP mode with custom port:**

```bash
MCP_PORT=3901 pnpm run server-http
```

### 4. Run a debug client

```bash
pnpm run debug-stdio
pnpm run debug-sdk
pnpm run debug-http
```

**HTTP client against a custom URL:**

```bash
MCP_URL="http://localhost:3901" pnpm run debug-http
```

## What the debug clients test

- **Connect**: reach the MCP server and report the negotiated protocol era
- **List tools**: seven tools, starting with `depscore`
- **Call depscore**: score a handful of sample npm and PyPI packages
- **Cleanup**: close the connection

No build is needed. Each client spawns `index.mts` and Node 24 strips the types.

## Troubleshooting

**Server not responding?**

- Check the health endpoint: `curl http://localhost:3000/health`
- Run `node index.mts login` for local stdio, or check the server's HTTP auth configuration
- Re-run with `SOCKET_DEBUG=1` for per-request traces on stderr

**HTTP client getting 404?**

- The MCP endpoint is `/`, so remove any path and any trailing slash from `MCP_URL`
- Verify the server is in HTTP mode (`MCP_HTTP_MODE=true`, which
  `pnpm run server-http` sets for you)

**STDIO client hanging?**

- Ctrl+C to exit
- Make sure `MCP_HTTP_MODE` is not exported in your shell; it would put the
  spawned server into HTTP mode, where it never reads stdin
