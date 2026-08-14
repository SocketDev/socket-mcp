# Socket MCP Server

<a href="https://socket.dev/npm/package/@socketsecurity/mcp"><img src="https://socket.dev/api/badge/npm/package/@socketsecurity/mcp" alt="Socket Badge" height="20"></a>
<img src="https://raw.githubusercontent.com/SocketDev/socket-mcp/HEAD/assets/repo/coverage.svg" width="104" height="20" alt="Coverage" />

[![Follow @SocketSecurity](https://img.shields.io/twitter/follow/SocketSecurity?style=social)](https://twitter.com/SocketSecurity)
[![Follow @socket.dev on Bluesky](https://img.shields.io/badge/Follow-@socket.dev-1DA1F2?style=social&logo=bluesky)](https://bsky.app/profile/socket.dev)

A Model Context Protocol (MCP) server for Socket integration - lets AI assistants query dependency vulnerability scores and security metadata.

Socket MCP exposes Socket.dev's package-scoring API through the Model Context Protocol, so any MCP-aware AI assistant (Claude, VS Code Copilot, Cursor, Windsurf) can score a package, audit a `package.json`, or flag risky dependencies as part of a conversation. It ships as both a hosted public server (`https://mcp.socket.dev/`, no setup) and a self-hostable npm package, so you can choose between zero-friction and full data isolation.

## ✨ Features

- 🔍 **Dependency Security Scanning** - Get comprehensive security scores for npm, PyPI, cargo, Maven, NuGet, RubyGems, Go Modules, and more ([supported ecosystems](https://docs.socket.dev/docs/language-support))
- 🌐 **Public Hosted Service** - Use our public server at `https://mcp.socket.dev/`; sign in once via OAuth, no self-hosting
- 🚀 **Multiple Deployment Options** - Run locally via stdio, HTTP, or use our service
- 🤖 **AI Assistant Integration** - Works seamlessly with Claude, VS Code Copilot, Cursor, and other MCP clients
- 📊 **Batch Processing** - Check multiple dependencies in a single request
- 🔒 **OAuth Sign-In** - Public server authenticates through your MCP client's OAuth flow; no API key to copy or manage

🛠️ This project is in early development and rapidly evolving.

## Install

### Option 1: Use the public Socket MCP server (recommended)

The easiest way to get started. The public server uses OAuth - your MCP client opens a browser to sign in to Socket on first connect; no API key to copy or manage. Click a button below to install in your favorite AI assistant.

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Socket_MCP-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=socket-mcp&config={"url":"https://mcp.socket.dev/","type":"http"})
[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=socket-mcp&config=eyJ0eXBlIjoiaHR0cCIsInVybCI6Imh0dHBzOi8vbWNwLnNvY2tldC5kZXYvIn0%3D)

<details><summary><b>Manual install - Claude Desktop / Claude Code</b></summary>

Custom integrations are not available on every paid Claude plan. Check [Anthropic's remote-MCP article](https://support.anthropic.com/en/articles/11175166-about-custom-integrations-using-remote-mcp) before you start.

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
4. Ask Claude "Check the security score for express version 4.18.2".

For Claude Code, one command does all of it:

```sh
claude mcp add --transport http socket-mcp https://mcp.socket.dev/
```

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

### Option 2: Self-host the Socket MCP server

Self-hosting keeps every request inside your own infrastructure. It needs a Socket API token and Node.js 24 or later.

**Get a token first.** Sign in at [socket.dev](https://socket.dev/), open the API tokens page, and create a token with the `packages:list` scope. That single scope covers `depscore`; the org-scoped tools need whatever scopes your organization requires for the endpoints they call. Full walkthrough: [creating and managing API tokens](https://docs.socket.dev/reference/creating-and-managing-api-tokens).

**Then pick a transport.** The server speaks the same MCP protocol either way; the difference is who launches it.

|                        | Stdio (Option 2a)                             | HTTP (Option 2b)                                                     |
| ---------------------- | --------------------------------------------- | -------------------------------------------------------------------- |
| Who starts the process | Your MCP client, on demand                    | You, as a long-running service                                       |
| Who it serves          | One local user                                | Any client that can reach the port                                   |
| Where the token lives  | The client's config, as an env var            | The server env, or per-request `Authorization` headers               |
| Reach for it when      | You are a developer wiring up your own editor | You are deploying one instance for a team, or fronting it with OAuth |

Stdio is the default and the right answer for a single developer. Choose HTTP when more than one person, or something that is not a local process, needs to reach the server.

<details><summary><b>Option 2a - Stdio mode (default)</b></summary>

Claude Code:

```sh
claude mcp add socket-mcp -e SOCKET_API_TOKEN="your-api-token-here" -- pnpm dlx @socketsecurity/mcp@latest
```

Most other MCP clients:

```json
{
  "mcpServers": {
    "socket-mcp": {
      "command": "npx",
      "args": ["@socketsecurity/mcp@latest"],
      "env": {
        "SOCKET_API_TOKEN": "your-api-token-here"
      }
    }
  }
}
```

</details>

<details><summary><b>Option 2b - HTTP mode</b></summary>

Run the server in HTTP mode with pnpm dlx:

```sh
MCP_HTTP_MODE=true SOCKET_API_TOKEN=your-api-token pnpm dlx @socketsecurity/mcp@latest --http
```

The server listens on `http://localhost:3000/`. The MCP endpoint is `/` and the health endpoint is `/health`; every other path answers `404`.

The transport is stateless. Each `POST /` is self-contained, with no session to open, no `Mcp-Session-Id` header, and nothing to expire, so you can put several instances behind a load balancer without session affinity. `GET` and `DELETE` on the MCP endpoint answer `405`. Clients written against the 2025 protocol, which open with an `initialize` handshake, are still served.

Environment variables for HTTP mode:

| Variable                                   | Required                         | Default | Description                                                                                                                                |
| ------------------------------------------ | -------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `MCP_HTTP_MODE`                            | Yes, unless you pass `--http`    | `false` | Set to `true` to serve HTTP instead of stdio. The `--http` CLI flag does the same thing.                                                   |
| `MCP_PORT`                                 | No                               | `3000`  | Port to bind the HTTP server to.                                                                                                           |
| `SOCKET_API_TOKEN`                         | Required unless OAuth is enabled | None    | Socket API token for outbound API calls. See the alias list below.                                                                         |
| `SOCKET_OAUTH_ISSUER`                      | With OAuth                       | None    | OAuth issuer URL. Must be `https` on a public host. See "Enabling OAuth" below.                                                            |
| `SOCKET_OAUTH_INTROSPECTION_CLIENT_ID`     | With OAuth                       | None    | Client ID used for RFC 7662 token introspection.                                                                                           |
| `SOCKET_OAUTH_INTROSPECTION_CLIENT_SECRET` | With OAuth                       | None    | Client secret used for RFC 7662 token introspection.                                                                                       |
| `SOCKET_OAUTH_REQUIRED_SCOPES`             | No                               | None    | Scopes required on incoming access tokens, separated by spaces or commas. When unset, any active token passes.                             |
| `SOCKET_OAUTH_REQUIRE_AUDIENCE`            | No                               | `false` | When `true`, reject an access token whose introspection response carries no `aud` claim. Read the audience note below first.               |
| `SOCKET_API_BASE_URL`                      | No                               | None    | Override the upstream Socket API endpoint. Falls back to `https://api.socket.dev` when unset.                                              |
| `SOCKET_DEBUG`                             | No                               | `false` | Turns on verbose request and cache tracing on stderr, points `depscore` at `http://localhost:8866`, and permits a local OAuth issuer.      |
| `TRUST_PROXY`                              | No                               | `false` | Trust `X-Forwarded-Host` and `X-Forwarded-Proto` when building OAuth metadata URLs. Enable only behind a reverse proxy that rewrites them. |

The three OAuth variables are a set: configure all three or none. Setting only some of them makes the server print `Incomplete OAuth configuration for HTTP mode` and exit `1`, rather than quietly start unauthenticated.

`SOCKET_API_TOKEN` is canonical. These aliases are read in order, first non-empty wins: `SOCKET_API_TOKEN`, `SOCKET_API_KEY`, `SOCKET_CLI_API_TOKEN`, `SOCKET_CLI_API_KEY`, `SOCKET_SECURITY_API_TOKEN`, `SOCKET_SECURITY_API_KEY`.

`SOCKET_API_TOKEN`, `SOCKET_API_BASE_URL`, and `SOCKET_DEBUG` also apply in stdio mode. Everything else in the table is HTTP-only.

<details>

<summary>Tuning the package-file blob cache and its fetches</summary>

`package_files`, `package_file_contents`, and `package_file_grep` fetch blobs from `socketusercontent.com` and hold them in a process-wide LRU cache. These knobs exist for operators running the server at volume; the defaults are fine otherwise.

| Variable                     | Default                         | Description                                                                                                |
| ---------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `SOCKET_BLOB_CACHE_BYTES`    | `67108864` (64 MB)              | Bytes the blob cache holds before evicting. A non-positive or unparseable value falls back to the default. |
| `SOCKET_BLOB_URL`            | `https://socketusercontent.com` | Base URL blobs are fetched from.                                                                           |
| `SOCKET_BROWSER_USER_AGENT`  | A Chrome UA string              | `User-Agent` sent on blob fetches.                                                                         |
| `SOCKET_BYPASS_HEADER_NAME`  | None                            | Name of an extra header sent on every blob fetch. Both name and value must be set for it to apply.         |
| `SOCKET_BYPASS_HEADER_VALUE` | None                            | Value for that header.                                                                                     |
| `SOCKET_INTERNAL_USER_AGENT` | `socket-internal-tool/1.0`      | `User-Agent` sent on the authenticated file-list call.                                                     |

</details>

**Enabling OAuth.** Set all three OAuth variables to require an OAuth access token on every MCP request:

```sh
MCP_HTTP_MODE=true \
SOCKET_OAUTH_ISSUER=https://issuer.example.com \
SOCKET_OAUTH_INTROSPECTION_CLIENT_ID=your-client-id \
SOCKET_OAUTH_INTROSPECTION_CLIENT_SECRET=your-client-secret \
pnpm dlx @socketsecurity/mcp@latest --http
```

With OAuth enabled, every request to the MCP endpoint goes through RFC 7662 token introspection. A raw Socket API token is rejected with a `401`, whatever its prefix; a `sktsec_` token is no more privileged than any other string here. Callers send an OAuth access token, and the server uses that token for the Socket API calls it makes on their behalf. Run without the OAuth variables to accept raw Socket API tokens instead.

At startup the server discovers the issuer's RFC 8414 metadata. An issuer that carries a path (`https://auth.example.com/tenant1`) is probed at the path-inserted well-known URL first (`https://auth.example.com/.well-known/oauth-authorization-server/tenant1`), and the metadata document's own `issuer` must match `SOCKET_OAUTH_ISSUER` byte for byte. The issuer must be `https` on a public host; a loopback or private-network issuer is refused outright unless `SOCKET_DEBUG=true` is set for local-stack work. The same rule applies to the `introspection_endpoint` the metadata advertises.

Clients discover how to authenticate from `GET /.well-known/oauth-protected-resource` (RFC 9728), which the server publishes once OAuth is on:

```json
{
  "resource": "https://mcp.example.com/",
  "authorization_servers": ["https://issuer.example.com"],
  "scopes_supported": ["packages:list"],
  "bearer_methods_supported": ["header"],
  "resource_name": "Socket MCP Server"
}
```

A rejected request answers `401` with a `WWW-Authenticate` header naming that metadata URL and the scopes this resource requires:

```text
WWW-Authenticate: Bearer error="invalid_token", error_description="Invalid or expired token",
  resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="packages:list"
```

> [!IMPORTANT]
> **Audience validation.** When an introspection response includes an `aud` claim, the server requires it to name this resource and rejects the token otherwise. That check is always on and has no opt-out. When the response includes no `aud` at all, the token is accepted by default, because an authorization server that never emits the claim would otherwise fail every request. Audience validation therefore protects you exactly as far as your authorization server populates `aud`; if it does not, no audience is being checked. Set `SOCKET_OAUTH_REQUIRE_AUDIENCE=true` to additionally require the claim's presence, but only once you have confirmed your authorization server returns `aud` on introspection. Enabling it against a server that omits the claim rejects all traffic.

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

<details><summary>The full tool roster - names, arguments, and what each returns</summary>

#### depscore

Query the Socket API for dependency scoring information. Returns supply chain, quality, maintenance, vulnerability, and license scores per package.

| Parameter              | Type   | Required | Default     | Description                                                                                                                                                                              |
| ---------------------- | ------ | -------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages`             | Array  | ✅ Yes   | -           | Array of package objects to analyze                                                                                                                                                      |
| `packages[].ecosystem` | String | No       | `"npm"`     | Package ecosystem. See Supported ecosystems below.                                                                                                                                       |
| `packages[].depname`   | String | ✅ Yes   | -           | Name of the dependency/package                                                                                                                                                           |
| `packages[].version`   | String | No       | `"unknown"` | Version of the dependency                                                                                                                                                                |
| `platform`             | String | No       | -           | OS-architecture hint (`linux-x64`, `darwin-arm64`, `win32-x64`) applied to every package in the request. Picks the most relevant artifact when a package ships platform-specific builds. |

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

`packagist` is accepted as an alias for `composer`, and `openvsx` for the `vscode` PURL type.

Example request:

```json
{
  "packages": [
    { "ecosystem": "npm", "depname": "express", "version": "4.18.2" },
    { "ecosystem": "pypi", "depname": "fastapi", "version": "0.100.0" }
  ]
}
```

Response, as a single block of text. Every score is an integer from 0 to 100, higher is better:

```text
Dependency scores:
pkg:npm/express@4.18.2: license: 100, maintenance: 87, quality: 100, supplyChain: 97, vulnerability: 98
  Report: https://socket.dev/npm/package/express
pkg:pypi/fastapi@0.100.0: license: 100, maintenance: 100, quality: 100, supplyChain: 100, vulnerability: 100
  Report: https://socket.dev/pypi/package/fastapi
```

Packages come back in the order the API returns them, not the order you asked for. A package Socket has no record of is left out of the list rather than reported as an error, so compare the response against your request when a name is missing.

#### organizations

List the Socket organizations the authenticated user belongs to. Takes no parameters. Use it to discover the `org_slug` value that the org-scoped tools (`alerts`, `threat_feed`) require.

This tool needs a Socket API token. See [Authentication for organization-scoped tools](#authentication-for-organization-scoped-tools) below.

The response is the Socket API's JSON, keyed by organization id. The `slug` is what the other tools want:

```json
{
  "organizations": {
    "1234": {
      "id": "1234",
      "name": "Acme Robotics",
      "plan": "enterprise",
      "slug": "acme-robotics"
    }
  }
}
```

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
| `cursor`        | String  | No       | -       | Pagination cursor - the `endCursor` from a previous response                          |

#### threat_feed

Look up items in a Socket organization's threat feed: packages recently flagged as malware, typosquats, obfuscated code, and similar. Backed by `GET /v0/orgs/{org_slug}/threat-feed`. The response carries a `nextPageCursor`; pass it as `cursor` to page forward.

| Parameter           | Type    | Required | Default      | Description                                                                                                        |
| ------------------- | ------- | -------- | ------------ | ------------------------------------------------------------------------------------------------------------------ |
| `org_slug`          | String  | ✅ Yes   | -            | Organization slug (get it from the `organizations` tool)                                                           |
| `filter`            | String  | No       | `mal`        | Threat category: `mal` (malware), `vuln`, `typ` (typosquat), `obf` (obfuscated), `mjo`, `kes`, `spy`, etc.         |
| `ecosystem`         | String  | No       | -            | Ecosystem: `npm`, `pypi`, `gem`, `maven`, `golang`, `nuget`, `cargo`, `chrome`, `openvsx`, `vscode`, `huggingface` |
| `name`              | String  | No       | -            | Filter by package name                                                                                             |
| `version`           | String  | No       | -            | Filter by package version                                                                                          |
| `is_human_reviewed` | Boolean | No       | `false`      | Only return human-reviewed items                                                                                   |
| `sort`              | String  | No       | `updated_at` | Sort field: `id`, `created_at`, `updated_at`                                                                       |
| `direction`         | String  | No       | `desc`       | Sort direction: `asc`, `desc`                                                                                      |
| `updated_after`     | String  | No       | -            | ISO timestamp; only items updated after this                                                                       |
| `created_after`     | String  | No       | -            | ISO timestamp; only items created after this                                                                       |
| `per_page`          | Integer | No       | `30`         | Results per page (1–100)                                                                                           |
| `cursor`            | String  | No       | -            | Pagination cursor - the `nextPageCursor` from a previous response                                                  |

#### package_files

List the files published in a package: a tree of file paths, each with its size and blob hash, for any package on a supported ecosystem. Use it to inspect what a dependency ships before installing it. Pass a file's `hash` to `package_file_contents` or `package_file_grep`.

| Parameter    | Type   | Required | Default | Description                                                                             |
| ------------ | ------ | -------- | ------- | --------------------------------------------------------------------------------------- |
| `ecosystem`  | String | No       | `npm`   | `npm`, `pypi`, `gem`, `cargo`, `maven`, `golang`, `nuget`, `chrome`, `openvsx`          |
| `depname`    | String | ✅ Yes   | -       | Package name (e.g. `lodash`, `@babel/core`, `org.springframework:spring-core`)          |
| `version`    | String | ✅ Yes   | -       | Package version                                                                         |
| `artifactId` | String | No       | -       | Per-version disambiguator (PyPI filename, Maven artifact id, NuGet asset)               |
| `platform`   | String | No       | -       | Platform qualifier for per-OS/arch artifacts (e.g. openvsx `linux-x64`, `darwin-arm64`) |

Output is a header line and a tree. The token after each size is the blob `hash`:

```text
pkg:npm/lodash@4.17.21 — 1054 files, 1379.3 KB
└── package/
    ├── fp/
    │   ├── __.js  43B  QlKUJ6782LHNEISw-t4uX1hyH1TCZye4ShYOMIAghheg
    │   ├── _baseConvert.js  16.0K  QpGkoQltpQn5ZeTFxYQOnk8FWp-7yyeUQtyzdZXl48nA
```

#### package_file_contents

Read a single file from a package. Pass the `hash` printed next to an entry in `package_files` output. Returns up to 1 MB of UTF-8 text; binary files return metadata only.

| Parameter | Type   | Required | Default | Description                                             |
| --------- | ------ | -------- | ------- | ------------------------------------------------------- |
| `hash`    | String | ✅ Yes   | -       | Blob hash from `package_files`                          |
| `path`    | String | No       | -       | File path, for display only; does not affect the lookup |

#### package_file_grep

Search a single file from a package for lines matching a JavaScript regular expression, returning matches with line numbers (grep -n style). Each blob is fetched once and held in a process-wide cache, so repeated reads and greps of the same hash skip the network.

| Parameter         | Type    | Required | Default | Description                                             |
| ----------------- | ------- | -------- | ------- | ------------------------------------------------------- |
| `hash`            | String  | ✅ Yes   | -       | Blob hash from `package_files`                          |
| `pattern`         | String  | ✅ Yes   | -       | JavaScript regular expression (plain literals work too) |
| `caseInsensitive` | Boolean | No       | `false` | Match case-insensitively                                |
| `contextLines`    | Integer | No       | `0`     | Lines of context before and after each match (0–5)      |
| `maxMatches`      | Integer | No       | `100`   | Cap on matching lines returned (1–500)                  |
| `path`            | String  | No       | -       | File path, for display only; does not affect the lookup |

</details>

### Authentication for organization-scoped tools

`depscore` works without credentials on the public server. The `organizations`, `alerts`, `threat_feed`, and `package_files` tools call Socket's authenticated REST API, so they need a Socket API token.

How the server resolves a token depends on the transport:

- **stdio mode** reads one token at startup from the environment and uses it for every request. Set `SOCKET_API_TOKEN`. The server also accepts these aliases, in priority order: `SOCKET_API_TOKEN` → `SOCKET_API_KEY` → `SOCKET_CLI_API_TOKEN` → `SOCKET_CLI_API_KEY` → `SOCKET_SECURITY_API_TOKEN` → `SOCKET_SECURITY_API_KEY`. `SOCKET_API_TOKEN` is canonical; `SOCKET_API_KEY` is the alias most local setups already export. Because the process belongs to one user, this token is yours and scopes every tool to your account.
- **HTTP mode** scopes the organization tools to the caller, never to the server's own token. Send your credential as an `Authorization: Bearer <token>` header on each request. Which credential to send depends on whether the deployment runs OAuth. On an OAuth-enabled server, send an OAuth access token: every bearer token is validated through introspection, and a raw Socket API token is rejected with a `401` challenge no matter what it starts with. On a server without OAuth, send your raw Socket API token and it is used directly. Either way the server uses that per-request token for the Socket API calls it makes on your behalf. A shared deployment never answers `organizations`, `alerts`, `threat_feed`, or `package_files` with the operator's data: when a request carries no token, those tools return the auth-required error. `depscore` alone may fall back to the server's startup token, since package scores are the same for every caller.

When a token is missing, every affected tool returns the same message:

```text
Authentication is required. Set SOCKET_API_TOKEN for stdio mode, or send your Socket API
token as an `Authorization: Bearer <token>` header (or connect through OAuth) in HTTP mode.
```

Generate a token from the [Socket dashboard](https://socket.dev/) under API tokens, then export it before launching the server:

```sh
export SOCKET_API_TOKEN="your-socket-api-token"
```

### Worked example: organization details and alerts

With `SOCKET_API_TOKEN` set, ask your assistant something like "show me the open critical alerts for my Socket org". Under the hood the assistant chains two tools:

1. **Discover the org slug.** Call `organizations` (no arguments). The server reads your token, calls `GET /v0/organizations`, and returns the organizations your token can see. Pick the `slug` you want, e.g. `acme-robotics`.

2. **Fetch alerts for that org.** Call `alerts` with the slug and any filters:

   ```json
   {
     "org_slug": "acme-robotics",
     "severity": "high,critical",
     "status": "open"
   }
   ```

   The server calls `GET /v0/orgs/acme-robotics/alerts` with the same token and returns the matching alerts plus pagination metadata. To page forward, pass the response's `endCursor` back as `cursor`.

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

The repo ships an optional [Claude Code hook](https://code.claude.com/docs/en/hooks) that blocks high-risk packages before installation. When Claude Code runs an install command, the hook queries the public Socket MCP server at `https://mcp.socket.dev/` and denies the install when the package's supply chain score is below `20` (known malware, typosquats, high-risk supply chain signals). No CLI to install - copy the file and wire it up; the public server signs in via OAuth on first use.

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

<details><summary>Per-client setup steps - Claude Desktop, Claude Code, Cursor, and VS Code</summary>

**Prerequisites:** Node.js 24+.

1. Copy the whole `dist/socket-gate` directory into your hooks folder. The
   bundled `socket-gate.cjs` is self-contained, so it runs without any
   dependencies beside it.

   From a published install:

   ```bash
   mkdir -p ~/.claude/hooks
   cp -R node_modules/@socketsecurity/mcp/dist/socket-gate ~/.claude/hooks/
   ```

   From a checkout, build it first:

   ```bash
   pnpm run build
   mkdir -p ~/.claude/hooks
   cp -R dist/socket-gate ~/.claude/hooks/
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

</details>

### How it works

The hook denies installation when `supplyChain < 20`, allows it otherwise - e.g. `express`/`lodash`/`react` (75–97) allow, `browserlist` (typosquat of `browserslist`, 15) and confirmed malware (0) block. Network, timeout, or parse errors all fail open, so a Socket outage will not block legitimate work.

### Limitations

A best-effort guardrail, not a complete defense. Known gaps:

- **Manifest edits + lockfile installs.** If Claude edits a manifest directly (`package.json`, `requirements.txt`, `Cargo.toml`, `Gemfile`, `go.mod`, `*.csproj`) then runs a bare install (`npm install`, `pip install -r requirements.txt`, `cargo build`, `bundle install`, `go mod tidy`, `dotnet restore`), there is no package name on the command line to check.
- **Package-manager invocations only.** Direct downloads (`curl | sh`, `wget`), post-install scripts of already-accepted packages, and transitive dependencies are not re-checked.
- **Indirect Claude paths.** Sub-agents, MCP tools that shell out, and non-`Bash` tool calls are not covered unless the `matcher` is broadened.

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

| Task                      | Command                             |
| ------------------------- | ----------------------------------- |
| Test                      | `pnpm test`                         |
| Test one file             | `pnpm test test/unit/purl.test.mts` |
| Live-API end-to-end tests | `pnpm run test:e2e`                 |
| Type check                | `pnpm run type`                     |
| Lint and format           | `pnpm run fix --all`                |
| Full check suite          | `pnpm run check --all`              |
| Bundle to `dist/`         | `pnpm run build`                    |

Never put `--` before a test path; that widens the run to the whole suite. Write `pnpm test test/unit/purl.test.mts`.

To drive a running server by hand, see [mock-client debugging](docs/mock-client-debugging.md).

### Health check endpoint

When running in HTTP mode, `GET /health` returns the running server's version and skips origin validation, which makes it safe to call from a probe that sends no `Origin` header:

```json
{
  "status": "healthy",
  "service": "socket-mcp",
  "version": "0.0.20",
  "timestamp": "2026-07-29T01:50:30.394Z"
}
```

Suitable for Kubernetes liveness/readiness probes, Docker health checks, load balancers.

### Troubleshooting

**Q: The public server isn't responding** - Check the URL `https://mcp.socket.dev/`, verify your MCP client configuration, restart your MCP client.

**Q: Local server fails to start** - Ensure Node.js 24+ is installed, check `SOCKET_API_TOKEN` is set, verify the API token has `packages:list` permission. In stdio mode a missing token is fatal: the server prints `SOCKET_API_TOKEN environment variable is required in stdio mode` and exits `1`.

**Q: The server exits with `Incomplete OAuth configuration for HTTP mode`** - `SOCKET_OAUTH_ISSUER`, `SOCKET_OAUTH_INTROSPECTION_CLIENT_ID`, and `SOCKET_OAUTH_INTROSPECTION_CLIENT_SECRET` must all be set or all be unset.

**Q: Getting authentication errors with local server** - Double-check your API key is valid, ensure `packages:list` scope, regenerate if needed. If the tool that failed was `organizations`, `alerts`, `threat_feed`, or `package_files` on an HTTP deployment, the server is refusing to answer with the operator's token by design; send your own in an `Authorization: Bearer` header.

**Q: AI assistant can't find the depscore tool** - Restart your MCP client after configuration changes, verify config is saved, check the server is running. `tools/list` advertises a one-hour public cache, so a client that caches the tool list may need a restart to pick up a newly added tool.

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
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/SocketDev/socket-mcp/HEAD/logo-white.png">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/SocketDev/socket-mcp/HEAD/logo-black.png">
    <img width="324" height="108" alt="Socket Logo" src="https://raw.githubusercontent.com/SocketDev/socket-mcp/HEAD/logo-black.png">
  </picture>
</div>
