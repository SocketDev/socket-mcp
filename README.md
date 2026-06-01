# Socket MCP Server

[![npm version](https://badge.fury.io/js/@socketsecurity%2Fmcp.svg)](https://badge.fury.io/js/@socketsecurity%2Fmcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Socket Badge](https://socket.dev/api/badge/npm/package/@socketsecurity/mcp)](https://socket.dev/npm/package/@socketsecurity/mcp)

A Model Context Protocol (MCP) server for Socket integration — lets AI assistants query dependency vulnerability scores and security metadata.

## Why this repo exists

Socket MCP exposes Socket.dev's package-scoring API through the Model Context Protocol, so any MCP-aware AI assistant (Claude, VS Code Copilot, Cursor, Windsurf) can score a package, audit a `package.json`, or flag risky dependencies as part of a conversation. It ships as both a hosted public server (`https://mcp.socket.dev/`, no setup) and a self-hostable npm package, so you can choose between zero-friction and full data isolation.

## ✨ Features

- 🔍 **Dependency Security Scanning** - Get comprehensive security scores for npm, PyPI, and other package ecosystems
- 🌐 **Public Hosted Service** - Use our public server at `https://mcp.socket.dev/` with no setup required
- 🚀 **Multiple Deployment Options** - Run locally via stdio, HTTP, or use our service
- 🤖 **AI Assistant Integration** - Works seamlessly with Claude, VS Code Copilot, Cursor, and other MCP clients
- 📊 **Batch Processing** - Check multiple dependencies in a single request
- 🔒 **No Authentication Required** - Public server requires no API keys or registration

🛠️ This project is in early development and rapidly evolving.

## Install

### Option 1: Use the public Socket MCP server (recommended)

The easiest way to get started. **No API key or authentication required!** Click a button below to install in your favorite AI assistant.

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Socket_MCP-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=socket-mcp&config={"url":"https://mcp.socket.dev/","type":"http"})
[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=socket-mcp&config=eyJ0eXBlIjoiaHR0cCIsInVybCI6Imh0dHBzOi8vbWNwLnNvY2tldC5kZXYvIn0%3D)

<details><summary><b>Manual install — Claude Desktop / Claude Code</b></summary>

> [!NOTE]
> Custom integrations are not available to all paid versions of Claude. Check [here](https://support.anthropic.com/en/articles/11175166-about-custom-integrations-using-remote-mcp) for more information.

1. In Claude Desktop, go to Settings > Developer > Edit Config.
2. Add the Socket MCP server configuration:

```json
{
  "mcpServers": {
    "socket-mcp": {
      "type": "http",
      "url": "https://mcp.socket.dev/"
    }
  }
}
```

3. Save the configuration and restart Claude Desktop.
4. Now you can ask Claude "Check the security score for express version 4.18.2".

For Claude Code:

```sh
claude mcp add --transport http socket-mcp https://mcp.socket.dev/
```

</details>

<details><summary><b>Manual install — VS Code</b></summary>

```sh
# For VS Code with GitHub Copilot
code --add-mcp '{"name":"socket-mcp","type":"http","url":"https://mcp.socket.dev/"}'
```

Or add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "socket-mcp": {
      "type": "http",
      "url": "https://mcp.socket.dev/"
    }
  }
}
```

</details>

<details><summary><b>Manual install — Cursor</b></summary>

`Cursor Settings` → `MCP` → `Add new MCP Server`. Name `socket-mcp`, `http` type, URL `https://mcp.socket.dev/`.

```json
{
  "mcpServers": {
    "socket-mcp": {
      "type": "http",
      "url": "https://mcp.socket.dev/"
    }
  }
}
```

</details>

<details><summary><b>Manual install — Windsurf</b></summary>

> [!WARNING]
> Windsurf does not support `http` type MCP servers yet. Use the stdio configuration in Option 2 below.

```json
{
  "mcpServers": {
    "socket-mcp": {
      "serverUrl": "https://mcp.socket.dev/mcp"
    }
  }
}
```

</details>

### Option 2: Self-host the Socket MCP server

To run your own instance, create an API key first (only the `packages:list` permission scope is needed; see [creating-and-managing-api-tokens](https://docs.socket.dev/reference/creating-and-managing-api-tokens)).

<details><summary><b>Option 2a — Stdio mode (default)</b></summary>

Claude Code:

```sh
claude mcp add socket-mcp -e SOCKET_API_TOKEN="your-api-token-here" -- npx -y @socketsecurity/mcp@latest # socket-hook: allow npx
```

Most other MCP clients:

```json
{
  "mcpServers": {
    "socket-mcp": {
      "command": "npx", // socket-hook: allow npx
      "args": ["@socketsecurity/mcp@latest"],
      "env": {
        "SOCKET_API_TOKEN": "your-api-token-here"
      }
    }
  }
}
```

</details>

<details><summary><b>Option 2b — HTTP mode</b></summary>

Run the server in HTTP mode using npx:

```sh
MCP_HTTP_MODE=true SOCKET_API_TOKEN=your-api-token npx @socketsecurity/mcp@latest --http # socket-hook: allow npx
```

Environment variables for HTTP mode:

| Variable                                   | Required                                                     | Default                                                          | Description                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SOCKET_API_TOKEN`                         | Required unless OAuth is enabled                             | None                                                             | Socket API token used for outbound API calls. Legacy aliases (`SOCKET_API_KEY`, `SOCKET_CLI_API_TOKEN`, `SOCKET_CLI_API_KEY`, `SOCKET_SECURITY_API_TOKEN`, `SOCKET_SECURITY_API_KEY`) are accepted via the fleet's `getSocketApiToken()` helper. If unset in OAuth-enabled HTTP mode, the validated incoming bearer token is forwarded upstream instead. |
| `SOCKET_OAUTH_ISSUER`                      | Set together with the two introspection vars to enable OAuth | None                                                             | OAuth issuer URL used for metadata discovery and incoming bearer-token validation.                                                                                                                                                                                                                                                                       |
| `SOCKET_OAUTH_INTROSPECTION_CLIENT_ID`     | With OAuth                                                   | None                                                             | Client ID used for token introspection.                                                                                                                                                                                                                                                                                                                  |
| `SOCKET_OAUTH_INTROSPECTION_CLIENT_SECRET` | With OAuth                                                   | None                                                             | Client secret used for token introspection.                                                                                                                                                                                                                                                                                                              |
| `SOCKET_OAUTH_REQUIRED_SCOPES`             | No                                                           | `packages:list`                                                  | Space-delimited scopes required on incoming access tokens.                                                                                                                                                                                                                                                                                               |
| `SOCKET_API_URL`                           | No                                                           | Production Socket API URL, or localhost when `SOCKET_DEBUG=true` | Override the upstream Socket API endpoint. Useful for local development and testing.                                                                                                                                                                                                                                                                     |
| `SOCKET_DEBUG`                             | No                                                           | `false`                                                          | Switches the default upstream Socket API endpoint to localhost when `SOCKET_API_URL` is unset.                                                                                                                                                                                                                                                           |
| `TRUST_PROXY`                              | No                                                           | `false`                                                          | When `true`, trust `X-Forwarded-Host` and `X-Forwarded-Proto` when building OAuth metadata URLs. Enable only behind a trusted reverse proxy that rewrites these headers.                                                                                                                                                                                 |
| `MCP_PORT`                                 | HTTP mode only                                               | `3000`                                                           | Port to bind the HTTP server to.                                                                                                                                                                                                                                                                                                                         |

`SOCKET_API_URL` and `SOCKET_DEBUG` also apply in stdio mode.

To enable OAuth-backed auth for incoming MCP requests:

```sh
MCP_HTTP_MODE=true \
SOCKET_OAUTH_ISSUER=https://issuer.example.com \
SOCKET_OAUTH_INTROSPECTION_CLIENT_ID=your-client-id \
SOCKET_OAUTH_INTROSPECTION_CLIENT_SECRET=your-client-secret \
npx @socketsecurity/mcp@latest --http # socket-hook: allow npx
```

Add `TRUST_PROXY=true` only when the server is deployed behind a trusted reverse proxy or load balancer that normalizes the forwarded host and protocol headers.

Configure your MCP client to connect to the HTTP server:

```json
{
  "mcpServers": {
    "socket-mcp": {
      "type": "http",
      "url": "http://localhost:3000"
    }
  }
}
```

</details>

## Usage

Once installed, ask your AI assistant questions like:

- "Check the security score for express version 4.18.2"
- "Analyze the security of my package.json dependencies"
- "What are the vulnerability scores for react, lodash, and axios?"

### Tools exposed

#### depscore

Query the Socket API for dependency scoring information. Returns supply chain, quality, maintenance, vulnerability, and license scores per package.

| Parameter              | Type   | Required | Default     | Description                                      |
| ---------------------- | ------ | -------- | ----------- | ------------------------------------------------ |
| `packages`             | Array  | ✅ Yes   | -           | Array of package objects to analyze              |
| `packages[].ecosystem` | String | No       | `"npm"`     | Package ecosystem (`npm`, `pypi`, `cargo`, etc.) |
| `packages[].depname`   | String | ✅ Yes   | -           | Name of the dependency/package                   |
| `packages[].version`   | String | No       | `"unknown"` | Version of the dependency                        |

Example request:

```json
{
  "packages": [
    { "ecosystem": "npm", "depname": "express", "version": "4.18.2" },
    { "ecosystem": "pypi", "depname": "fastapi", "version": "0.100.0" }
  ]
}
```

Sample response:

```
pkg:npm/express@4.18.2: supply_chain: 1.0, quality: 0.9, maintenance: 1.0, vulnerability: 1.0, license: 1.0
pkg:pypi/fastapi@0.100.0: supply_chain: 1.0, quality: 0.95, maintenance: 0.98, vulnerability: 1.0, license: 1.0
```

### Adjusting tool usage via client rules

You can customize how the MCP server interacts with your AI assistant by editing your client's rules file:

| MCP Client          | Rules File Location               |
| ------------------- | --------------------------------- |
| Claude Desktop/Code | `CLAUDE.md`                       |
| VSCode Copilot      | `.github/copilot-instructions.md` |
| Cursor              | `.cursor/rules`                   |

Example rule:

```md
Always check dependency scores with the depscore tool when you add a new dependency. If the score is low, consider using an alternative library or writing the code yourself.
```

## Development

<details>
<summary>Contributor commands</summary>

```sh
git clone https://github.com/SocketDev/socket-mcp.git
cd socket-mcp
npm install
npm run build
```

Run from source (stdio mode):

```sh
export SOCKET_API_TOKEN=your_api_token_here
node --experimental-strip-types index.ts
```

Or in HTTP mode:

```sh
MCP_HTTP_MODE=true SOCKET_API_TOKEN=your_api_token_here node --experimental-strip-types index.ts --http
```

### Health check endpoint

When running in HTTP mode, `GET /health` returns:

```json
{
  "status": "healthy",
  "service": "socket-mcp",
  "version": "0.0.3",
  "timestamp": "2025-06-17T20:45:22.059Z"
}
```

Suitable for Kubernetes liveness/readiness probes, Docker health checks, load balancers.

### Troubleshooting

**Q: The public server isn't responding** — Check the URL `https://mcp.socket.dev/`, verify your MCP client configuration, restart your MCP client.

**Q: Local server fails to start** — Ensure Node.js v16+ is installed, check `SOCKET_API_TOKEN` is set, verify the API token has `packages:list` permission.

**Q: Getting authentication errors with local server** — Double-check your API key is valid, ensure `packages:list` scope, regenerate if needed.

**Q: AI assistant can't find the depscore tool** — Restart your MCP client after configuration changes, verify config is saved, check the server is running.

### Getting help

- 📖 [Socket Documentation](https://docs.socket.dev)
- 🐛 [Report Issues](https://github.com/SocketDev/socket-mcp/issues)
- 💬 [Community Support](https://github.com/SocketDev/socket-mcp/discussions)

</details>

## License

MIT

<br/>
<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="logo-white.png">
    <source media="(prefers-color-scheme: light)" srcset="logo-black.png">
    <img width="324" height="108" alt="Socket Logo" src="logo-black.png">
  </picture>
</div>
