# Service and tool reference

Socket MCP exposes a stateless MCP server over stdio or HTTP. Its hosted deployment at `https://mcp.socket.dev/` uses OAuth. A self-hosted process can use local stdio credentials, raw API tokens on HTTP, or OAuth-backed HTTP. The request identity and credential rules differ by transport; see [Authentication](#authentication-for-organization-scoped-tools).

The server registers the tools in `lib/server.mts`; schemas and handlers are defined in the corresponding `lib/tool-*.mts` modules. The tables below list the current tool inputs. See [the command reference](commands.md) for launch modes, environment variables, and self-hosting setup.

### Tools exposed

<details><summary>The full tool roster - names, arguments, and what each returns</summary>

#### depscore

Query the Socket API for dependency scores. The result formats the available score components and includes a Socket report URL when the record has an overall score. Records without an overall score are labeled `No score found`.

| Parameter              | Type   | Required | Default     | Description                                                                                                                                                                              |
| ---------------------- | ------ | -------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages`             | Array  | ✅ Yes   | -           | Array of package objects to analyze                                                                                                                                                      |
| `packages[].ecosystem` | String | No       | `"npm"`     | Package ecosystem. See Supported ecosystems below.                                                                                                                                       |
| `packages[].depname`   | String | ✅ Yes   | -           | Name of the dependency/package                                                                                                                                                           |
| `packages[].version`   | String | No       | `"unknown"` | Version of the dependency                                                                                                                                                                |
| `platform`             | String | No       | -           | OS-architecture hint (`linux-x64`, `darwin-arm64`, `win32-x64`) applied to every package in the request. Picks the most relevant artifact when a package ships platform-specific builds. |

##### Supported ecosystems

The `ecosystem` value is used as a PURL type. Common values listed in the input schema are:

| Ecosystem                 | PURL type  |
| ------------------------- | ---------- |
| JavaScript and TypeScript | `npm`      |
| Python                    | `pypi`     |
| Go                        | `golang`   |
| Java, Scala, and Kotlin   | `maven`    |
| Ruby                      | `gem`      |
| .NET                      | `nuget`    |
| Rust                      | `cargo`    |
| PHP                       | `composer` |

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

The tool returns one text block. These placeholders show its line structure; actual fields and values come from the Socket API:

```text
Dependency scores:
pkg:npm/<package>@<version>: <score fields returned by the API>
  Report: <Socket package report URL>
pkg:pypi/<package>@<version>: No score found
```

The API response determines which package records appear. Compare the result with the request when you need to confirm that each requested package had a matching record.

#### organizations

List the Socket organizations the authenticated user belongs to. Takes no parameters. Use it to discover the `org_slug` value that the org-scoped tools (`alerts`, `threat_feed`) require.

This tool needs a Socket API token. See [Authentication for organization-scoped tools](#authentication-for-organization-scoped-tools) below.

The response is the Socket API's JSON, keyed by organization id. The `slug` is what the other tools want:

```json
{
  "organizations": {
    "1234": {
      "id": "1234",
      "name": "Example Organization",
      "plan": "team",
      "slug": "example-org"
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
pkg:npm/<package>@<version> - <file-count> files, <size> KB
└── package/
    ├── fp/
    │   ├── <file-name>  <size>  <blob-hash>
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

The tools that call the Socket API need credentials. `depscore`, `organizations`, `alerts`, `threat_feed`, and `package_files` use a Socket API token. `package_file_contents` and `package_file_grep` use a blob hash and do not take a token.

How the server resolves a token depends on the transport:

- **stdio mode** reads one Socket API token at startup from the environment and uses it for each API-backed tool call. Set `SOCKET_API_TOKEN`. Accepted names, in priority order, are `SOCKET_API_TOKEN`, `SOCKET_API_KEY`, `SOCKET_CLI_API_TOKEN`, `SOCKET_CLI_API_KEY`, `SOCKET_SECURITY_API_TOKEN`, and `SOCKET_SECURITY_API_KEY`.
- **HTTP mode without OAuth** accepts a Socket API token in an `Authorization: Bearer <token>` header on each request. Tools scoped to an organization use the caller's token and do not fall back to a shared operator token. `depscore` can fall back to the server's startup token because package scores are public data.
- **HTTP mode with OAuth** requires an OAuth access token on every MCP request. The server validates it through introspection and uses that caller credential for Socket API calls. A raw Socket API token is rejected with a `401` challenge.

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

1. **Discover the org slug.** Call `organizations` (no arguments). The server reads your token, calls `GET /v0/organizations`, and returns the organizations your token can see. Pick the `slug` you want, such as `example-org`.

2. **Fetch alerts for that org.** Call `alerts` with the slug and any filters:

   ```json
   {
     "org_slug": "example-org",
     "severity": "high,critical",
     "status": "open"
   }
   ```

   The server calls `GET /v0/orgs/example-org/alerts` with the same token and returns the matching alerts plus pagination metadata. To page forward, pass the response's `endCursor` back as `cursor`.

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

## HTTP service behavior

The HTTP transport serves MCP requests at `/`, answers `GET /health` with the running version, and returns `404` for other paths. It is stateless: each request is self-contained. `GET` and `DELETE` on `/` return `405`. Requests with an `Origin` header are checked against the request host; health probes do not need an `Origin` header.

When OAuth is enabled, the service publishes protected-resource metadata at `/.well-known/oauth-protected-resource` and validates each bearer token through the configured issuer's introspection endpoint. OAuth configuration and the distinction between OAuth access tokens and Socket API tokens are covered in [Authentication for organization-scoped tools](#authentication-for-organization-scoped-tools).

The HTTP request body limit is 4 MiB. Larger requests receive `413 Request body too large`. Unhandled request failures return an MCP internal error when the response is still writable. Tool input schemas reject extra properties and invalid values before a handler runs. Missing credentials return an error result. Upstream failures return an error result with an HTTP status when available.

Tool results use text content. `organizations`, `alerts`, and `threat_feed` serialize the Socket API response as JSON. `package_files` returns a file tree with sizes and hashes. The two blob tools return text or a message that identifies binary content.

### Audit events

Each tool call produces a bounded, versioned audit event. By default, the server appends JSONL records to `~/.socket/mcp-audit.jsonl`. Set `SOCKET_MCP_AUDIT_LOG` to choose another file or `SOCKET_MCP_AUDIT_SINK=stderr` to write records to stderr. The default sink is JSONL. Unknown sink values produce a diagnostic and fall back to JSONL. Existing records are left in place.

### Health check endpoint

In HTTP mode, `GET /health` returns a JSON object with `status`, `service`, `version`, and `timestamp`. The endpoint skips origin validation so a health probe can omit `Origin`.

### Troubleshooting

- A local stdio process exits at startup when no Socket API token is configured. Set `SOCKET_API_TOKEN` or one of its documented aliases.
- HTTP OAuth requires all three values: `SOCKET_OAUTH_ISSUER`, `SOCKET_OAUTH_INTROSPECTION_CLIENT_ID`, and `SOCKET_OAUTH_INTROSPECTION_CLIENT_SECRET`. Partial configuration makes startup fail.
- On HTTP deployments, `organizations`, `alerts`, `threat_feed`, and `package_files` require the caller's credential. The server does not use a shared operator token for those organization-scoped requests.
- If a client does not show a newly added tool, restart the client. The `tools/list` response is cached for up to one hour.
