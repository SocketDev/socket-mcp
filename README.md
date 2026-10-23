# Socket MCP Server

<a href="https://socket.dev/npm/package/@socketsecurity/mcp"><img src="https://badge.socket.dev/npm/package/@socketsecurity/mcp" alt="Socket Badge" height="20"></a>
<picture><img src="https://raw.githubusercontent.com/SocketDev/socket-mcp/HEAD/assets/repo/coverage.svg?v=66258ab9f3b4" height="20" alt="Coverage" /></picture>

[![Follow @SocketSecurity](https://img.shields.io/twitter/follow/SocketSecurity?style=social)](https://twitter.com/SocketSecurity)
[![Follow @socket.dev on Bluesky](https://img.shields.io/badge/Follow-@socket.dev-1DA1F2?style=social&logo=bluesky)](https://bsky.app/profile/socket.dev)

Socket MCP lets AI assistants query Socket's dependency security scores and metadata through the Model Context Protocol (MCP).
Use it to score a package, audit a `package.json`, or identify risky dependencies in a conversation.
Connect your MCP client to the hosted server at `https://mcp.socket.dev/` and authenticate through OAuth, or run the npm package yourself.

## ✨ Features

- 🔍 **Dependency Security Scanning** - Get comprehensive security scores for npm, PyPI, cargo, Maven, NuGet, RubyGems, Go Modules, and more ([supported ecosystems](https://docs.socket.dev/docs/language-support))
- 🌐 **Public Hosted Service** - Use our public server at `https://mcp.socket.dev/` and sign in through your MCP client's OAuth flow
- 🚀 **Multiple Deployment Options** - Run locally via stdio, HTTP, or use our service
- 🤖 **AI Assistant Integration** - Connect from MCP-compatible clients; OAuth behavior varies by client
- 📊 **Batch Processing** - Check multiple dependencies in a single request
- 🔒 **OAuth Sign-In** - Public server authenticates through your MCP client's OAuth flow; no API key to copy or manage

🛠️ This project is in early development and rapidly evolving.

## Install

### Option 1: Use the public Socket MCP server (recommended)

The public server requires Socket sign-in through OAuth for every tool call, including package scoring. Some MCP clients need an explicit sign-in step. You do not need an API key.

- [Install in VS Code](https://vscode.dev/redirect/mcp/install?name=socket-mcp&config=%7B%22url%22%3A%22https%3A%2F%2Fmcp.socket.dev%2F%22%2C%22type%22%3A%22http%22%7D).
- [Install in Cursor](https://cursor.com/en/install-mcp?name=socket-mcp&config=eyJ0eXBlIjoiaHR0cCIsInVybCI6Imh0dHBzOi8vbWNwLnNvY2tldC5kZXYvIn0%3D).

<details><summary><b>Manual install - Claude Desktop / Claude Code</b></summary>

Add the hosted server through Claude's [custom connector settings](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp). The Developer configuration file is for local servers.

1. Open Customize > Connectors in Claude.
2. Select **Add custom connector** and enter `https://mcp.socket.dev/` as the server URL. On Team and Enterprise plans, an organization owner adds the connector through Organization settings > Connectors first.
3. Select **Connect** and complete the Socket authorization flow when prompted.
4. Enable the connector for your conversation, then ask Claude "Check the security score for express version 4.18.2".

For Claude Code, add the server:

```sh
claude mcp add --transport http socket-mcp https://mcp.socket.dev/
```

Then run `/mcp`, select `socket-mcp`, choose **Authenticate** (or **Re-authenticate**, if shown), and approve access in your browser. An "authenticated" status before sign-in does not mean organization tools are ready.

</details>

<details><summary><b>Manual install - Codex CLI</b></summary>

Add the server:

```sh
codex mcp add socket-mcp --url https://mcp.socket.dev/
```

Codex starts sign-in during this command. You may see an `invalid_scope` page before Codex automatically retries with the three MCP read permissions. Complete the browser authorization on the retry.

To avoid that initial error page, you can instead add the server directly to `~/.codex/config.toml`:

```toml
[mcp_servers.socket-mcp]
url = "https://mcp.socket.dev/"
scopes = ["packages:list", "alerts:list", "threat-feed:list"]
```

Then run:

```sh
codex mcp login socket-mcp
```

With dynamic client registration, each sign-in creates a new OAuth client with Socket.

</details>

<details><summary><b>Manual install - VS Code</b></summary>

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

<details><summary><b>Manual install - Cursor</b></summary>

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

<details><summary><b>Manual install - Windsurf</b></summary>

Windsurf does not support `http` type MCP servers. Use the stdio configuration in Option 2 below, or the `serverUrl` form:

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

<details><summary><b>Manual install - Factory</b></summary>

[Factory](https://factory.ai) is an AI-powered software engineering platform. Install the Socket MCP server with the Factory CLI:

```bash
droid mcp add socket https://mcp.socket.dev/ --type http
```

To self-host with an API key instead, see Option 2 below and register the stdio command with `droid mcp add`.

Alternatively, type `/mcp` within the Factory droid to manage MCP servers from an interactive UI. Learn more in the [Factory MCP documentation](https://docs.factory.ai/cli/configuration/mcp).

</details>

### Clients that need a local bridge

Prefer your client's native remote HTTP connection to `https://mcp.socket.dev/` when available. For clients that only launch local stdio servers, install `mcp-remote` 0.8.3:

```bash
pnpm add --global mcp-remote@0.8.3
```

Add this local server configuration to your MCP client:

```json
{
  "mcpServers": {
    "socket": {
      "command": "mcp-remote",
      "args": ["https://mcp.socket.dev/"]
    }
  }
}
```

The bridge runs on your computer and receives OAuth redirects at `http://localhost:<port>/oauth/callback`. Keep it running while you authorize. Version 0.3.3 introduced the [mid-session authorization fix](https://github.com/punkpeye/mcp-remote/pull/340); the forwarding and reauthorization retry paths were verified against the published 0.8.3 package. This verification does not cover a complete browser sign-in.

Reuse saved authorization while it remains valid. If a browser reports connection refused at the localhost callback, check the bridge's version and process. The callback listener belongs to the bridge; changing the hosted MCP URL does not start it.

### Option 2: Self-host the Socket MCP server

See the [self-hosted server instructions](docs/commands.md#self-hosted-server) for installation, stdio and HTTP setup, environment variables, and OAuth configuration.

## Usage

Once installed, ask your AI assistant questions like:

- "Check the security score for express version 4.18.2"
- "Analyze the security of my package.json dependencies"
- "What are the vulnerability scores for react, lodash, and axios?"

### Documentation

- [Service and tool reference](docs/service.md) lists every tool, input, result, authentication rule, and HTTP behavior.
- [Server commands and workflows](docs/commands.md) covers local launch, self-hosting, environment variables, and the optional Claude Code hook.

### Tools exposed

The complete tool roster, schemas, parameters, and result examples are in the [service reference](docs/service.md#tools-exposed).

<details><summary>Tool quick links</summary>

#### depscore

See [depscore](docs/service.md#depscore).

#### organizations

See [organizations](docs/service.md#organizations).

#### alerts

See [alerts](docs/service.md#alerts).

#### threat_feed

See [threat_feed](docs/service.md#threat_feed).

#### package_files

See [package_files](docs/service.md#package_files).

#### package_file_contents

See [package_file_contents](docs/service.md#package_file_contents).

#### package_file_grep

See [package_file_grep](docs/service.md#package_file_grep).

</details>

### Authentication

See the [authentication reference](docs/service.md#authentication-for-organization-scoped-tools) for local tokens, per-request HTTP credentials, and hosted OAuth.

### Worked example: organization details and alerts

See the [organization and alerts example](docs/service.md#worked-example-organization-details-and-alerts).

### Adjusting tool usage via client rules

See [client rule examples](docs/service.md#adjusting-tool-usage-via-client-rules).

### Claude Code Hook (Optional)

The optional Socket package guard is documented in the [commands and workflows reference](docs/commands.md#claude-code-hook-optional).

### Setup

See the [hook setup instructions](docs/commands.md#setup).

### How it works

See [how the hook works](docs/commands.md#how-it-works).

### Limitations

See the [hook limitations](docs/commands.md#limitations).

Inspired by [Jimmy Vo's dependency hook](https://blog.jimmyvo.com/posts/claudes-dependency-hook/).

## Development

<details>
<summary>Contributor commands</summary>

This repo uses pnpm, and every command runs from the repo root. Node.js 24+ is required.

```sh
git clone https://github.com/SocketDev/socket-mcp.git
cd socket-mcp
pnpm install
```

Run from source. No build step is needed, because Node 24 strips the TypeScript itself:

```sh
export SOCKET_API_TOKEN=your_api_token_here
pnpm run server-stdio
```

Or in HTTP mode:

```sh
pnpm run server-http
```

Both scripts read `SOCKET_API_TOKEN` (falling back to `SOCKET_API_KEY`) from your environment. Append `:debug` to either one (`pnpm run server-http:debug`) to set `SOCKET_DEBUG=1` and get per-request tracing on stderr.

### Audit events

Audit-event destinations and record behavior are documented in the [service reference](docs/service.md#audit-events).

### Health check endpoint

The HTTP health response is documented in the [service reference](docs/service.md#health-check-endpoint).

### Troubleshooting

See [service troubleshooting](docs/service.md#troubleshooting).

### Getting help

- 📖 [Socket Documentation](https://docs.socket.dev)
- 🐛 [Report Issues](https://github.com/SocketDev/socket-mcp/issues)
- 💬 [Community Support](https://github.com/SocketDev/socket-mcp/discussions)

</details>

## Compatibility

MCP is still evolving, and client implementations differ in how they handle parts of the protocol. We proactively track compatibility gaps and work to offer the best possible experience with Claude Code, Codex, Cursor, and Zed. The table below summarizes the latest tests and known gaps.

Snapshot dated October 2, 2026; tests ran September 29–October 1. Each result applies to the listed client version and setup.

| Client and tested setup                                   | Hosted OAuth result                                                                                                | Verified tools and continuity                                                                                                                   | Important limit or workaround                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code 2.1.285, hosted HTTP                          | First `organizations` call failed with a sign-in request; explicit OAuth then completed.                           | The 2.1.285 run verified the initial failure and successful login. `organizations` and `depscore` passed after login in a separate 2.1.284 run. | The pre-login “authenticated” label was misleading; see [upstream issue #98942](https://github.com/anthropics/claude-code/issues/98942).                                                                                                                                                                                                      |
| Codex CLI 0.159.2, hosted HTTP                            | Works after explicit login.                                                                                        | `organizations` and `depscore` passed after login, including a new conversation and idle checks.                                                | A broad scope request showed `invalid_scope` before Codex retried with the three MCP read permissions; see [upstream issue #15643](https://github.com/openai/codex/issues/15643).                                                                                                                                                             |
| Cursor 3.22.12, hosted HTTP OAuth                         | Fails in tested conditions: `organizations` remained Unauthorized; the Authenticate card did not establish access. | `organizations` only; no successful hosted OAuth call verified.                                                                                 | Cursor 3.20 recurrence was manually reported; no fix version is known. [A related forum reply](https://forum.cursor.com/t/plugin-mcp-oauth-never-reaches-needsauth-authenticate-button-missing-browser-never-opens/170058/8) describes an unsuccessful workaround attempt but identifies a separate Cursor 3.18.9 marketplace-import blocker. |
| Cursor, local stdio with API token (version not recorded) | Not applicable; this setup bypasses hosted OAuth.                                                                  | `depscore` passed; restart continuity was reported manually.                                                                                    | This does not verify hosted OAuth, `organizations`, or other tools.                                                                                                                                                                                                                                                                           |
| Zed Agent 1.22.0, hosted HTTP                             | Works after explicit OAuth.                                                                                        | `organizations` and `depscore` passed after login, restart, and a six-minute idle check.                                                        | Intermittent timeouts after idle, cause under investigation; four client timeouts matched fast server HTTP 400 responses.                                                                                                                                                                                                                     |

Only `organizations` and `depscore` were tested. Token refresh, server-side revocation, and all-tool coverage were not tested. Claude Desktop, VS Code, Windsurf, and Factory were not tested in this matrix.

## License

MIT

<div align="center">
  <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/SocketDev/socket-mcp/HEAD/assets/fleet/socket-combomark-dark.svg">
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/SocketDev/socket-mcp/HEAD/assets/fleet/socket-combomark-light.svg">
      <img width="320" height="91" alt="Socket" src="https://raw.githubusercontent.com/SocketDev/socket-mcp/HEAD/assets/fleet/socket-combomark-light.svg">
  </picture>
</div>
