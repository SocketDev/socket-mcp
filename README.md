# Socket MCP Server

[![npm version](https://badge.fury.io/js/@socketsecurity%2Fmcp.svg)](https://badge.fury.io/js/@socketsecurity%2Fmcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Socket Badge](https://socket.dev/api/badge/npm/package/@socketsecurity/mcp)](https://socket.dev/npm/package/@socketsecurity/mcp)

A Model Context Protocol (MCP) server for Socket integration, allowing AI assistants to efficiently check dependency vulnerability scores and security information.

## ✨ Features

- 🔍 **Dependency Security Scanning** - Get comprehensive security scores for npm, PyPI, and other package ecosystems
- 🌐 **Public Hosted Service** - Use our public server at `https://mcp.socket.dev/` with no setup required
- 🚀 **Multiple Deployment Options** - Run locally via stdio, HTTP, or use our service
- 🤖 **AI Assistant Integration** - Works seamlessly with Claude, VS Code Copilot, Cursor, and other MCP clients
- 📊 **Batch Processing** - Check multiple dependencies in a single request
- 🔒 **No Authentication Required** - Public server requires no API keys or registration

🛠️ This project is in early development and rapidly evolving.

## 🚀 Quick Start

### Option 1: Use the Public Socket MCP Server (Recommended)

The easiest way to get started is to use our public Socket MCP server. **No API key or authentication required!** Click a button below to install the public server in your favorite AI assistant.


[![Install in VS Code](https://img.shields.io/badge/VS_Code-Socket_MCP-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=socket-mcp&config={"url":"https://mcp.socket.dev/","type":"http"})
[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=socket-mcp&config=eyJ0eXBlIjoiaHR0cCIsInVybCI6Imh0dHBzOi8vbWNwLnNvY2tldC5kZXYvIn0%3D)


<details><summary><b>Manual Installation Instructions & more MCP Clients</b></summary>

<details><summary><b>Install in Claude Desktop or Claude Code</b></summary>

> [!NOTE]
> Custom integrations are not available to all paid versions of Claude. Check [here](https://support.anthropic.com/en/articles/11175166-about-custom-integrations-using-remote-mcp) for more information.

To use the public Socket MCP server with Claude Desktop:

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

4. Now you can ask Claude questions like "Check the security score for express version 4.18.2".

The process is similar for Claude Code. See the [Claude Code documentation](https://docs.anthropic.com/en/docs/claude-code/mcp) for more details. Here's an example command to add the Socket MCP server:

```bash
claude mcp add --transport http socket-mcp https://mcp.socket.dev/
```

</details>

<details><summary><b>Install in VS Code</b></summary>

You can install the Socket MCP server using the VS Code CLI:

```bash
# For VS Code with GitHub Copilot
code --add-mcp '{"name":"socket-mcp","type":"http","url":"https://mcp.socket.dev/}'
```

After installation, the Socket MCP server will be available for use with your GitHub Copilot agent in VS Code.

Alternatively, you can manually add it to your VS Code MCP configuration in `.vscode/mcp.json`:

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

<details><summary><b>Install in Cursor</b></summary>

Go to `Cursor Settings` -> `MCP` -> `Add new MCP Server`. Name it "socket-mcp", use `http` type with URL `https://mcp.socket.dev/`.

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

<details><summary><b>Install in Windsurf</b></summary>

> [!WARNING]
> Windsurf does not support `http` type MCP servers yet. Use the `stdio` configuration [below](#option-2a-stdio-mode-default).

To use the Socket MCP server in Windsurf:

1. Open Windsurf Settings
2. Navigate to MCP Servers section
3. Add a new server with the following configuration:

```json
{
    "mcpServers": {
        "socket-mcp": {
            "serverUrl": "https://mcp.socket.dev/mcp"
        }
    }
}
```

4. Save the configuration and restart Windsurf if needed.

</details>

</details>

### Option 2: Deploy Socket MCP Server on your machine

If you prefer to run your own instance, you can deploy the Socket MCP server locally using either stdio or HTTP modes.

### Getting an API key

To use a local Socket MCP Server, you need to create an API key. You can do this by following [these steps](https://docs.socket.dev/reference/creating-and-managing-api-tokens). The only required permission scope is `packages:list`, which allows the MCP server to query package metadata for dependency scores.

For local deployment, you have two options:

##### Option 2a: Stdio Mode (Default)

Click a button below to install the self-hosted stdio server in your favorite AI assistant.

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Socket_MCP-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=socket-mcp&config={"command":"npx","args":["@socketsecurity/mcp@latest"],"type":"stdio"})
[![Install in Cursor (stdio)](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=socket-mcp&config=eyJjb21tYW5kIjoibnB4IEBzb2NrZXRzZWN1cml0eS9tY3BAbGF0ZXN0IiwiZW52Ijp7IlNPQ0tFVF9BUElfS0VZIjoieW91ci1hcGkta2V5LWhlcmUifX0%3D)

Claude Code (stdio mode) can be set up with the following command:

```bash
claude mcp add socket-mcp -e SOCKET_API_KEY="your-api-key-here" -- npx -y @socketsecurity/mcp@latest
```
This is how the configuration looks like on most MCP clients:

```json
{
  "mcpServers": {
    "socket-mcp": {
      "command": "npx",
      "args": ["@socketsecurity/mcp@latest"],
      "env": {
        "SOCKET_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

This approach automatically uses the latest version without requiring global installation.


##### Option 2b: HTTP Mode

1. Run the server in HTTP mode using npx:
   ```bash
   MCP_HTTP_MODE=true SOCKET_API_KEY=your-api-key npx @socketsecurity/mcp@latest --http
   ```

   HTTP mode supports these environment variables:

   | Variable | Required | Default | Description |
   |---|---|---|---|
   | `SOCKET_API_KEY` | Required unless OAuth is enabled | None | Socket API key used for outbound API calls. If unset in OAuth-enabled HTTP mode, the validated incoming bearer token is forwarded upstream instead. |
   | `SOCKET_OAUTH_ISSUER` | Set together with the two introspection vars to enable OAuth | None | OAuth issuer URL used for metadata discovery and incoming bearer-token validation. |
   | `SOCKET_OAUTH_INTROSPECTION_CLIENT_ID` | With OAuth | None | Client ID used for token introspection. |
   | `SOCKET_OAUTH_INTROSPECTION_CLIENT_SECRET` | With OAuth | None | Client secret used for token introspection. |
   | `SOCKET_OAUTH_REQUIRED_SCOPES` | No | `packages:list` | Space-delimited scopes required on incoming access tokens. |
   | `SOCKET_API_URL` | No | Production Socket API URL, or localhost when `SOCKET_DEBUG=true` | Override the upstream Socket API endpoint. Useful for local development and testing. |
   | `SOCKET_DEBUG` | No | `false` | Switches the default upstream Socket API endpoint to localhost when `SOCKET_API_URL` is unset. |
   | `TRUST_PROXY` | No | `false` | When `true`, trust `X-Forwarded-Host` and `X-Forwarded-Proto` when building OAuth metadata URLs. Enable only behind a trusted reverse proxy that rewrites these headers. |
   | `MCP_PORT` | HTTP mode only | `3000` | Port to bind the HTTP server to. |

   `SOCKET_API_URL` and `SOCKET_DEBUG` also apply in stdio mode.
   In OAuth-enabled HTTP mode, if `SOCKET_API_KEY` is unset, the authenticated client's bearer token is forwarded to the Socket API. That token therefore must also be accepted by the configured upstream Socket API.

   To enable OAuth-backed auth for incoming MCP requests:

   ```bash
   MCP_HTTP_MODE=true \
   SOCKET_OAUTH_ISSUER=https://issuer.example.com \
   SOCKET_OAUTH_INTROSPECTION_CLIENT_ID=your-client-id \
   SOCKET_OAUTH_INTROSPECTION_CLIENT_SECRET=your-client-secret \
   npx @socketsecurity/mcp@latest --http
   ```

   Add `TRUST_PROXY=true` only when the server is deployed behind a trusted reverse proxy or load balancer that normalizes the forwarded host and protocol headers.

2. Configure your MCP client to connect to the HTTP server:
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

## Tools exposed by the Socket MCP Server

### depscore

The `depscore` tool allows AI assistants to query the Socket API for dependency scoring information. It provides comprehensive security and quality metrics for packages across different ecosystems.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `packages` | Array | ✅ Yes | - | Array of package objects to analyze |
| `packages[].ecosystem` | String | No | `"npm"` | Package ecosystem (`npm`, `pypi`, `cargo`, etc.) |
| `packages[].depname` | String | ✅ Yes | - | Name of the dependency/package |
| `packages[].version` | String | No | `"unknown"` | Version of the dependency |

**Example Usage:**

```json
{
  "packages": [
    {
      "ecosystem": "npm",
      "depname": "express",
      "version": "4.18.2"
    },
    {
      "ecosystem": "pypi",
      "depname": "fastapi",
      "version": "0.100.0"
    }
  ]
}
```

**Sample Response:**
```
pkg:npm/express@4.18.2: supply_chain: 1.0, quality: 0.9, maintenance: 1.0, vulnerability: 1.0, license: 1.0
pkg:pypi/fastapi@0.100.0: supply_chain: 1.0, quality: 0.95, maintenance: 0.98, vulnerability: 1.0, license: 1.0
```

### How to Use the Socket MCP Server

1. **Ask your AI assistant** to check dependencies:
   - "Check the security score for express version 4.18.2"
   - "Analyze the security of my package.json dependencies"
   - "What are the vulnerability scores for react, lodash, and axios?"

2. **Get comprehensive security insights** including supply chain, quality, maintenance, vulnerability, and license scores.

### Adjust tool usage with custom rules

You can further customize how the Socket MCP server interacts with your AI assistant by modifying your client rules. The rules are usually a markdown file and its location depends on the AI assistant you are using.

| MCP Client | Rules File Location |
|---|---|
| Claude Desktop/Code | `CLAUDE.md`  |
| VSCode Copilot | `.github/copilot-instructions.md`  |
| Cursor | `.cursor/rules` |


Rules that can be added to the client rules file include the following:

```md
Always check dependency scores with the depscore tool when you add a new dependency. If the score is low, consider using an alternative library or writing the code yourself. If you are unsure about the score, ask for a review from someone with more experience. When checking dependencies, make sure to also check the imports not just the pyproject.toml/package.json/dependency file.
```

You can adjust the rules to fit your needs. For example, you can add rules to include specific manifest files, or guide the AI assistant on how to handle low scores. The rules are flexible and can be tailored to your workflow.


## Development

### For End Users

For most users, we recommend using either:
1. **Public server**: `https://mcp.socket.dev/` (no setup required)
2. **NPX command**: `npx @socketsecurity/mcp@latest` (always latest version)

### For Contributors

If you want to contribute to the Socket MCP server development:

### Health Check Endpoint

When running in HTTP mode, the server provides a health check endpoint for Kubernetes and Docker deployments:

```bash
GET /health
```

**Response:**
```json
{
  "status": "healthy",
  "service": "socket-mcp",
  "version": "0.0.3",
  "timestamp": "2025-06-17T20:45:22.059Z"
}
```

This endpoint can be used for:
- Kubernetes liveness and readiness probes
- Docker health checks
- Load balancer health monitoring
- General service monitoring


#### Prerequisites

- Node.js v16 or higher
- npm or yarn

#### Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/SocketDev/socket-mcp.git
cd socket-mcp
npm install
```

#### Build

This project is a directly runnable Node.js project using [Type stripping](https://nodejs.org/docs/latest/api/typescript.html).
If you are on Node.js 22, run with `node --experimental-strip-types index.ts`.
On any later versions of Node.js, you can simply run `node index.ts`.
In either version you can also run the npm run scripts which include the correct flags.

The js files will automatically be build when running `npm publish`, and cleaned up afterwards with `npm run clean`.

If you want to preview the build you can run:

```bash
npm run build
```

#### Run from Source

To run the Socket MCP server from source:

```bash
export SOCKET_API_KEY=your_api_key_here
node --experimental-strip-types index.ts
```

Or in HTTP mode:

```bash
MCP_HTTP_MODE=true SOCKET_API_KEY=your_api_key_here node --experimental-strip-types index.ts --http
```

## 🔧 Troubleshooting

### Common Issues

**Q: The public server isn't responding**
- Check that you're using the correct URL: `https://mcp.socket.dev/`
- Verify your MCP client configuration is correct
- Try restarting your MCP client

**Q: Local server fails to start**
- Ensure you have Node.js v16+ installed
- Check that your `SOCKET_API_KEY` environment variable is set
- Verify the API key has `packages:list` permission

**Q: Getting authentication errors with local server**
- Double-check your Socket API key is valid
- Ensure the key has the required `packages:list` scope
- Try regenerating your API key from the Socket dashboard

**Q: AI assistant can't find the depscore tool**
- Restart your MCP client after configuration changes
- Verify the server configuration is saved correctly
- Check that the MCP server is running (for local deployments)

### Getting Help

- 📖 [Socket Documentation](https://docs.socket.dev)
- 🐛 [Report Issues](https://github.com/SocketDev/socket-mcp/issues)
- 💬 [Community Support](https://github.com/SocketDev/socket-mcp/discussions)

<br/>
<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="logo-white.png">
    <source media="(prefers-color-scheme: light)" srcset="logo-black.png">
    <img width="324" height="108" alt="Socket Logo" src="logo-black.png">
  </picture>
</div>
