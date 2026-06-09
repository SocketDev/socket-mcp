# Socket MCP Server

[![npm version](https://badge.fury.io/js/@socketsecurity%2Fmcp.svg)](https://badge.fury.io/js/@socketsecurity%2Fmcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Socket Badge](https://socket.dev/api/badge/npm/package/@socketsecurity/mcp)](https://socket.dev/npm/package/@socketsecurity/mcp)

A Model Context Protocol (MCP) server for Socket integration — lets AI assistants query dependency vulnerability scores and security metadata.

## Why this repo exists

Socket MCP exposes Socket.dev's package-scoring API through the Model Context Protocol, so any MCP-aware AI assistant (Claude, VS Code Copilot, Cursor, Windsurf) can score a package, audit a `package.json`, or flag risky dependencies as part of a conversation. It ships as both a hosted public server (`https://mcp.socket.dev/`, no setup) and a self-hostable npm package, so you can choose between zero-friction and full data isolation.

## ✨ Features

- 🔍 **Dependency Security Scanning** - Get comprehensive security scores for npm, PyPI, cargo, Maven, NuGet, RubyGems, Go Modules, and more ([supported ecosystems](https://docs.socket.dev/docs/language-support))
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

<details><summary><b>Manual install — Factory</b></summary>

[Factory](https://factory.ai) is an AI-powered software engineering platform. Install the Socket MCP server with the Factory CLI:

```bash
droid mcp add socket https://mcp.socket.dev/ --type http
```

To self-host with an API key instead, see Option 2 below and register the stdio command with `droid mcp add`.

Alternatively, type `/mcp` within the Factory droid to manage MCP servers from an interactive UI. Learn more in the [Factory MCP documentation](https://docs.factory.ai/cli/configuration/mcp).

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

| Parameter              | Type   | Required | Default     | Description                                        |
| ---------------------- | ------ | -------- | ----------- | -------------------------------------------------- |
| `packages`             | Array  | ✅ Yes   | -           | Array of package objects to analyze                |
| `packages[].ecosystem` | String | No       | `"npm"`     | Package ecosystem. See Supported ecosystems below. |
| `packages[].depname`   | String | ✅ Yes   | -           | Name of the dependency/package                     |
| `packages[].version`   | String | No       | `"unknown"` | Version of the dependency                          |

**Supported ecosystems**

Based on [Socket's language support](https://docs.socket.dev/docs/language-support). The `ecosystem` parameter maps to PURL types:

| Ecosystem               | PURL type  | Package managers          | Maturity                                            |
| ----------------------- | ---------- | ------------------------- | --------------------------------------------------- |
| JavaScript & TypeScript | `npm`      | npm, yarn, pnpm, Bun, VLT | GA                                                  |
| Python                  | `pypi`     | uv, pip, Poetry, Anaconda | GA                                                  |
| Go                      | `golang`   | Go Modules                | GA                                                  |
| Java / Scala / Kotlin   | `maven`    | Maven, Gradle, sbt        | GA                                                  |
| Ruby                    | `gem`      | Bundler                   | GA                                                  |
| .NET (C#, F#, VB)       | `nuget`    | NuGet                     | GA                                                  |
| Rust                    | `cargo`    | cargo                     | GA                                                  |
| PHP                     | `composer` | Composer                  | Experimental                                        |
| GitHub Actions          | `actions`  | GitHub Actions workflows  | Experimental (workflow scanning, not package-level) |

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
  Report: https://socket.dev/npm/package/express
pkg:pypi/fastapi@0.100.0: supply_chain: 1.0, quality: 0.95, maintenance: 0.98, vulnerability: 1.0, license: 1.0
  Report: https://socket.dev/pypi/package/fastapi
```

#### organizations

List the Socket organizations the authenticated user belongs to. Takes no parameters. Use it to discover the `org_slug` value that the org-scoped tools (`alerts`, `threat_feed`) require.

This tool needs a Socket API token. See [Authentication for organization-scoped tools](#authentication-for-organization-scoped-tools) below.

#### alerts

List the latest security alerts for one Socket organization: supply-chain, vulnerability, quality, license, and maintenance issues across the org's monitored packages. Backed by `GET /v0/orgs/{org_slug}/alerts`. Results are paginated; pass the previous response's `endCursor` as `cursor` to fetch the next page.

| Parameter       | Type    | Required | Default | Description                                                                           |
| --------------- | ------- | -------- | ------- | ------------------------------------------------------------------------------------- |
| `org_slug`      | String  | ✅ Yes   | -       | Organization slug (get it from the `organizations` tool)                              |
| `severity`      | String  | No       | -       | Comma-separated subset of `low,medium,high,critical`                                  |
| `status`        | String  | No       | -       | `open` or `cleared`                                                                   |
| `category`      | String  | No       | -       | Comma-separated subset of `supplyChainRisk,maintenance,quality,license,vulnerability` |
| `artifact_type` | String  | No       | -       | Comma-separated ecosystems: `npm,pypi,gem,maven,golang,nuget,cargo,chrome,openvsx`    |
| `artifact_name` | String  | No       | -       | Restrict to a single package name                                                     |
| `alert_type`    | String  | No       | -       | Comma-separated Socket alert types (e.g. `usesEval,unmaintained`)                     |
| `repo_slug`     | String  | No       | -       | Comma-separated repository slugs                                                      |
| `per_page`      | Integer | No       | `100`   | Results per page (1–5000)                                                             |
| `cursor`        | String  | No       | -       | Pagination cursor — the `endCursor` from a previous response                          |

#### threat_feed

Look up items in a Socket organization's threat feed: packages recently flagged as malware, typosquats, obfuscated code, and similar. Backed by `GET /v0/orgs/{org_slug}/threat-feed`. The response carries a `nextPageCursor`; pass it as `cursor` to page forward.

| Parameter           | Type    | Required | Default      | Description                                                                                                |
| ------------------- | ------- | -------- | ------------ | ---------------------------------------------------------------------------------------------------------- |
| `org_slug`          | String  | ✅ Yes   | -            | Organization slug (get it from the `organizations` tool)                                                   |
| `filter`            | String  | No       | `mal`        | Threat category: `mal` (malware), `vuln`, `typ` (typosquat), `obf` (obfuscated), `mjo`, `kes`, `spy`, etc. |
| `ecosystem`         | String  | No       | -            | Ecosystem: `npm`, `pypi`, `gem`, `maven`, `golang`, `nuget`, `cargo`, `chrome`, `openvsx`, `huggingface`   |
| `name`              | String  | No       | -            | Filter by package name                                                                                     |
| `version`           | String  | No       | -            | Filter by package version                                                                                  |
| `is_human_reviewed` | Boolean | No       | `false`      | Only return human-reviewed items                                                                           |
| `sort`              | String  | No       | `updated_at` | Sort field: `id`, `created_at`, `updated_at`                                                               |
| `direction`         | String  | No       | `desc`       | Sort direction: `asc`, `desc`                                                                              |
| `updated_after`     | String  | No       | -            | ISO timestamp; only items updated after this                                                               |
| `created_after`     | String  | No       | -            | ISO timestamp; only items created after this                                                               |
| `per_page`          | Integer | No       | `30`         | Results per page (1–100)                                                                                   |
| `cursor`            | String  | No       | -            | Pagination cursor — the `nextPageCursor` from a previous response                                          |

#### package_files

List the files published in a package: a tree of paths and sizes for any package on a supported ecosystem. Use it to inspect what a dependency ships before installing it. Each entry prints a blob `hash` that `package_file_contents` and `package_file_grep` consume.

| Parameter    | Type   | Required | Default | Description                                                                             |
| ------------ | ------ | -------- | ------- | --------------------------------------------------------------------------------------- |
| `ecosystem`  | String | No       | `npm`   | `npm`, `pypi`, `gem`, `cargo`, `maven`, `golang`, `nuget`, `chrome`, `openvsx`          |
| `depname`    | String | ✅ Yes   | -       | Package name (e.g. `lodash`, `@babel/core`, `org.springframework:spring-core`)          |
| `version`    | String | ✅ Yes   | -       | Package version                                                                         |
| `artifactId` | String | No       | -       | Per-version disambiguator (PyPI filename, Maven artifact id, NuGet asset)               |
| `platform`   | String | No       | -       | Platform qualifier for per-OS/arch artifacts (e.g. openvsx `linux-x64`, `darwin-arm64`) |

#### package_file_contents

Read a single file from a package. Pass the `hash` printed next to an entry in `package_files` output. Returns up to 1 MB of UTF-8 text; binary files return metadata only.

| Parameter | Type   | Required | Default | Description                                             |
| --------- | ------ | -------- | ------- | ------------------------------------------------------- |
| `hash`    | String | ✅ Yes   | -       | Blob hash from `package_files`                          |
| `path`    | String | No       | -       | File path, for display only; does not affect the lookup |

#### package_file_grep

Search a single file from a package for lines matching a JavaScript regular expression, returning matches with line numbers (grep -n style). The file is fetched once per session and cached, so repeated greps on the same hash skip the network.

| Parameter         | Type    | Required | Default | Description                                             |
| ----------------- | ------- | -------- | ------- | ------------------------------------------------------- |
| `hash`            | String  | ✅ Yes   | -       | Blob hash from `package_files`                          |
| `pattern`         | String  | ✅ Yes   | -       | JavaScript regular expression (plain literals work too) |
| `caseInsensitive` | Boolean | No       | `false` | Match case-insensitively                                |
| `contextLines`    | Integer | No       | `0`     | Lines of context before and after each match (0–5)      |
| `maxMatches`      | Integer | No       | `100`   | Cap on matching lines returned (1–500)                  |
| `path`            | String  | No       | -       | File path, for display only; does not affect the lookup |

### Authentication for organization-scoped tools

`depscore` works without credentials on the public server. The `organizations`, `alerts`, `threat_feed`, and `package_files` tools call Socket's authenticated REST API, so they need a Socket API token.

How the server resolves a token depends on the transport:

- **stdio mode** reads one token at startup from the environment and uses it for every request. Set `SOCKET_API_TOKEN`. The server also accepts these aliases, in priority order: `SOCKET_API_TOKEN` → `SOCKET_API_KEY` → `SOCKET_CLI_API_TOKEN` → `SOCKET_CLI_API_KEY` → `SOCKET_SECURITY_API_TOKEN` → `SOCKET_SECURITY_API_KEY`. `SOCKET_API_TOKEN` is canonical; `SOCKET_API_KEY` is the alias most local setups already export. Because the process belongs to one user, this token is yours and scopes every tool to your account.
- **HTTP mode** scopes the organization tools to the caller, never to the server's own token. Send your Socket API token as an `Authorization: Bearer <token>` header on each request, or use an OAuth access token when the server runs OAuth. The server uses that per-request token for the Socket API calls it makes on your behalf. A shared deployment never answers `organizations`, `alerts`, `threat_feed`, or `package_files` with the operator's data: when a request carries no token, those tools return the auth-required error. `depscore` alone may fall back to the server's startup token, since package scores are the same for every caller.

Generate a token from the [Socket dashboard](https://socket.dev/) under API tokens, then export it before launching the server:

```sh
export SOCKET_API_TOKEN="your-socket-api-token"
```

When no token is available, these tools return an authentication-required error explaining how to supply one for each transport.

### Worked example: organization details and alerts

With `SOCKET_API_KEY` (or `SOCKET_API_TOKEN`) set, ask your assistant something like "show me the open critical alerts for my Socket org". Under the hood the assistant chains two tools:

1. **Discover the org slug.** Call `organizations` (no arguments). The server reads your token, calls `GET /v0/organizations`, and returns the organizations your token can see. Pick the `slug` you want, e.g. `my-org`.

2. **Fetch alerts for that org.** Call `alerts` with the slug and any filters:

   ```json
   {
     "org_slug": "my-org",
     "severity": "high,critical",
     "status": "open"
   }
   ```

   The server calls `GET /v0/orgs/my-org/alerts` with the same token and returns the matching alerts plus pagination metadata. To page forward, pass the response's `endCursor` back as `cursor`.

The same token scopes every org-scoped tool, so `threat_feed` and `package_files` work the moment `organizations` confirms which slug the token belongs to.

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

## Claude Code Hook (Optional)

The repo ships an optional [Claude Code hook](https://code.claude.com/docs/en/hooks) that blocks high-risk packages before installation. When Claude Code runs an install command, the hook queries the public Socket MCP server at `https://mcp.socket.dev/` and denies the install when the package's supply chain score is below `20` (known malware, typosquats, high-risk supply chain signals). No API key, no CLI, no registration — copy the file and wire it up.

Supported ecosystems and package managers:

| Ecosystem | Commands                                                                                  |
| --------- | ----------------------------------------------------------------------------------------- |
| npm       | `npm install`, `npm i`, `npm add`, `yarn add`, `pnpm add`, `bun add`                      |
| PyPI      | `pip install`, `pip3 install`, `uv add`, `uv pip install`, `poetry add`, `pipenv install` |
| Cargo     | `cargo add`, `cargo install`                                                              |
| RubyGems  | `gem install`, `bundle add`                                                               |
| Go        | `go get`, `go install`                                                                    |
| NuGet     | `dotnet add package`, `nuget install`                                                     |

### Setup

**Prerequisites:** Node.js 22+.

1. Copy the whole `socket-gate` directory into your hooks folder. The bundled
   `socket-gate.cjs` is self-contained, so it runs without any dependencies
   beside it. From a checkout, run `pnpm run build` first to produce it; from a
   published install, copy from `node_modules/@socketsecurity/mcp/`:

```bash
mkdir -p ~/.claude/hooks
cp -R hooks/socket-gate ~/.claude/hooks/
```

2. Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node ~/.claude/hooks/socket-gate/socket-gate.cjs"
          }
        ]
      }
    ]
  }
}
```

See [`hooks/socket-gate/README.md`](hooks/socket-gate/README.md) for the full
reference.

### How it works

The hook denies installation when `supplyChain < 20`, allows it otherwise — e.g. `express`/`lodash`/`react` (75–97) allow, `browserlist` (typosquat of `browserslist`, 15) and confirmed malware (0) block. Network, timeout, or parse errors all fail open, so a Socket outage will not block legitimate work.

### Limitations

A best-effort guardrail, not a complete defense. Known gaps:

- **Manifest edits + lockfile installs.** If Claude edits a manifest directly (`package.json`, `requirements.txt`, `Cargo.toml`, `Gemfile`, `go.mod`, `*.csproj`) then runs a bare install (`npm install`, `pip install -r requirements.txt`, `cargo build`, `bundle install`, `go mod tidy`, `dotnet restore`), there is no package name on the command line to check.
- **Package-manager invocations only.** Direct downloads (`curl | sh`, `wget`), post-install scripts of already-accepted packages, and transitive dependencies are not re-checked.
- **Indirect Claude paths.** Sub-agents, MCP tools that shell out, and non-`Bash` tool calls are not covered unless the `matcher` is broadened.

Inspired by [Jimmy Vo's dependency hook](https://blog.jimmyvo.com/posts/claudes-dependency-hook/).

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
