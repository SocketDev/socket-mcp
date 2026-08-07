# Socket MCP Debug Clients

Three debug clients for exercising the Socket MCP server without a real MCP
host. Run every command from the repo root.

Deeper walkthrough, expected output, and error decoding:
[`docs/mock-client-debugging.md`](../docs/mock-client-debugging.md).

## Protocol eras

The clients split across the two MCP protocol eras so both stay covered:

| Client            | Script                 | Era                                                                              |
| ----------------- | ---------------------- | -------------------------------------------------------------------------------- |
| `debug-client.ts` | `pnpm run debug-stdio` | Legacy 2025 - raw JSON-RPC frames, `initialize` + `notifications/initialized`    |
| `stdio-client.ts` | `pnpm run debug-sdk`   | Modern - SDK client, `versionNegotiation: { mode: 'auto' }` over stdio           |
| `http-client.ts`  | `pnpm run debug-http`  | Modern - SDK client, `versionNegotiation: { mode: 'auto' }` over Streamable HTTP |

`mode: 'auto'` probes the server with `server/discover` and falls back to the
2025 `initialize` handshake when the server only speaks the legacy protocol.
Each SDK client prints the negotiated era and protocol version at connect.

## Quick start

### 1. Check your Node version

```bash
node --version
# v24.0.0 or higher
```

### 2. Set the API token

Get one from the [Socket dashboard](https://socket.dev/) under API tokens; the
`packages:list` scope covers `depscore`.

```bash
export SOCKET_API_TOKEN=your-api-token
```

The debug clients read `SOCKET_API_TOKEN` and nothing else. The server accepts
aliases such as `SOCKET_API_KEY`, but the clients do not.

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

No build is needed. Each client spawns `index.ts` and Node 24 strips the types.

## Troubleshooting

**Server not responding?**

- Check the health endpoint: `curl http://localhost:3000/health`
- Verify `SOCKET_API_TOKEN` is set
- Re-run with `SOCKET_DEBUG=1` for per-request traces on stderr

**HTTP client getting 404?**

- The MCP endpoint is `/`, so remove any path and any trailing slash from `MCP_URL`
- Verify the server is in HTTP mode (`MCP_HTTP_MODE=true`, which
  `pnpm run server-http` sets for you)

**STDIO client hanging?**

- Ctrl+C to exit
- Make sure `MCP_HTTP_MODE` is not exported in your shell; it would put the
  spawned server into HTTP mode, where it never reads stdin
