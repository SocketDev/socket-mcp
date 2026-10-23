# Server commands and workflows

The `socket-mcp` executable starts the MCP service. It uses stdio by default, which lets an MCP client own the process. Pass `--http` or set `MCP_HTTP_MODE=true` to run an HTTP service. The [service and tool reference](service.md) documents the endpoint, tools, authentication behavior, and outputs.

## Self-hosted server

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

Install it once, globally, before either option:

```sh
pnpm add -g @socketsecurity/mcp
```

<details><summary><b>Option 2a - Stdio mode (default)</b></summary>

Claude Code:

```sh
claude mcp add socket-mcp -e SOCKET_API_TOKEN="your-api-token-here" -- socket-mcp
```

Most other MCP clients:

```json
{
  "mcpServers": {
    "socket-mcp": {
      "command": "socket-mcp",
      "env": {
        "SOCKET_API_TOKEN": "your-api-token-here"
      }
    }
  }
}
```

</details>

<details><summary><b>Option 2b - HTTP mode</b></summary>

Run the server in HTTP mode:

```sh
MCP_HTTP_MODE=true SOCKET_API_TOKEN=your-api-token socket-mcp --http
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
socket-mcp --http
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
> **Audience validation.** Every OAuth access token must include an `aud` claim naming this MCP resource. Tokens with a missing or different audience receive `401`. Authorize again with the resource URL from `GET /.well-known/oauth-protected-resource`; refreshing an older unbound grant will not add its audience. Custom authorization servers must include the resource in `aud` on introspection.

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

See [`hooks/socket-gate/README.md`](../hooks/socket-gate/README.md) for the full
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

## Development commands

From the repository root with Node.js 24 or later:

| Task                             | Command                              |
| -------------------------------- | ------------------------------------ |
| Run the stdio server from source | `pnpm run server-stdio`              |
| Run the HTTP server from source  | `pnpm run server-http`               |
| Enable request tracing           | Add `:debug` to either server script |
| Build the package                | `pnpm run build`                     |
| Check the registered MCP schema  | `pnpm run mcp:schema:check`          |

Both server scripts read `SOCKET_API_TOKEN`, falling back to `SOCKET_API_KEY`. Debug scripts set `SOCKET_DEBUG=1` and write request traces to stderr. See [mock-client debugging](mock-client-debugging.md) for sending requests to a local server.
