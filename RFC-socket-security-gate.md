# RFC: Socket Security Gate for AI Coding Tools

**Status:** Draft
**Author:** David Larsen
**Date:** 2026-02-05

## Problem

AI coding tools (Claude Code, Cursor, Windsurf, Copilot) install packages on behalf of developers. These tools execute `npm install`, `pip install`, `cargo add`, and similar commands through shell access with no security checkpoint. A compromised or malicious package gets installed the moment the AI decides to use it.

Socket's MCP server provides a `depscore` tool the AI can call voluntarily. But voluntary is the operative word. Nothing enforces a check when an AI tool runs a raw `npm install` through its shell.

The gap: no enforcement layer between AI tool execution and package installation.

## Solution Overview

Three components, each independent but designed to work together:

1. **PreToolUse Hook** (`socket-gate`): Intercepts `Bash` tool calls containing package install commands, checks packages against Socket's API, blocks risky installs before execution.
2. **CLAUDE.md directives**: Instructions that make the AI call MCP tools proactively before installing packages.
3. **Expanded MCP tools**: Beyond `depscore`, add tools that surface alerts, provide verdicts, and explain security risks to AI assistants.

```
┌─────────────────────────────────────────────────────────────┐
│ AI Coding Tool (Claude Code, Cursor, etc.)                  │
│                                                             │
│  "npm install left-pad"                                     │
│         │                                                   │
│         ▼                                                   │
│  ┌─────────────────┐    ┌──────────────────────────────┐    │
│  │ PreToolUse Hook  │───▶│ Socket API /v0/purl          │    │
│  │ (socket-gate)    │◀───│ score + alerts               │    │
│  └────────┬────────┘    └──────────────────────────────┘    │
│           │                                                  │
│     exit 0 (allow)  OR  exit 2 (block)                      │
│           │                                                  │
│           ▼                                                  │
│  ┌─────────────────┐                                        │
│  │ Bash tool exec   │                                       │
│  └─────────────────┘                                        │
└─────────────────────────────────────────────────────────────┘
```

## Non-Goals

- **Replacing the Socket CLI.** The CLI handles package manager wrapping, lockfile scanning, manifest generation, reachability analysis, and fix workflows. This project does not reimplement any of that. If a user has the CLI installed, great. This project does not require it.
- **Supporting non-Claude-Code tools initially.** The hook spec is Claude Code specific. Cursor/Windsurf equivalents are future work. The MCP tools and CLAUDE.md directives are portable across any MCP client.

## Dependencies

- **Socket API** (`https://api.socket.dev/v0/purl`): The only external dependency. All package checking goes through this endpoint.
- **`SOCKET_API_KEY`**: Required for authenticated API access. Free tier available at socket.dev.
- **`curl` + `jq`**: Required on the host for the hook script. Present on macOS and most Linux distributions by default.
- **Node.js >= 22**: Required for the MCP server (existing requirement).

The Socket CLI is NOT required. Everything in this spec calls the Socket API directly.

---

## Component 1: PreToolUse Hook (`socket-gate`)

### What It Does

A shell script that runs before every `Bash` tool call in Claude Code. It parses the command string, detects package install operations, extracts package names and ecosystems, checks them against Socket's PURL API, and either allows or blocks execution based on score thresholds.

### Hook Configuration

Location: `.claude/settings.json` (project-level, committed to repo) or `~/.claude/settings.json` (user-global).

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "socket-gate",
            "timeout": 30,
            "statusMessage": "Checking packages with Socket..."
          }
        ]
      }
    ]
  }
}
```

### Input Contract

The hook receives JSON on stdin with this shape:

```json
{
  "session_id": "abc123",
  "cwd": "/Users/dev/myproject",
  "tool_name": "Bash",
  "tool_input": {
    "command": "npm install express lodash",
    "description": "Install dependencies",
    "timeout": 120000
  }
}
```

### Command Detection

The hook must parse `tool_input.command` and detect install operations across ecosystems:

| Ecosystem | Patterns to Match |
|-----------|-------------------|
| npm | `npm install`, `npm i`, `npm add`, `npx`, `pnpm add`, `pnpm install`, `yarn add` |
| pypi | `pip install`, `pip3 install`, `uv pip install`, `uv add`, `poetry add`, `pipx install` |
| cargo | `cargo add`, `cargo install` |
| go | `go get`, `go install` |
| gem | `gem install`, `bundle add` |
| nuget | `dotnet add package`, `nuget install` |

**Commands that should pass through without an API call (not package installs):**
- `npm ci`, `npm install` (no package args, restores from lockfile)
- `pip install -r requirements.txt`, `pip install .`, `pip install -e ./local`
- `npm install ./local-pkg`, `npm install ../sibling`
- `npm run build`, `npm test`, `npm start`
- Any command not matching the patterns above

**Edge cases to handle:**
- Piped commands: `echo "test" && npm install foo` (extract the install portion)
- Flags mixed with package names: `npm install --save-dev @types/node`
- Scoped packages: `npm install @socketsecurity/mcp`
- Version pinning: `pip install requests==2.31.0`, `npm install lodash@4.17.21`
- Multiple packages: `npm install express body-parser cors`
- Chained with `&&` or `;`: parse each subcommand independently

### Package Extraction

Produce a list of `{ ecosystem, name, version }` tuples from the detected command. Version may be `unknown`.

Examples:
- `npm install express@4.18.2` -> `[{ ecosystem: "npm", name: "express", version: "4.18.2" }]`
- `pip install requests flask>=2.0` -> `[{ ecosystem: "pypi", name: "requests", version: "unknown" }, { ecosystem: "pypi", name: "flask", version: "2.0" }]`
- `cargo add serde --features derive` -> `[{ ecosystem: "cargo", name: "serde", version: "unknown" }]`
- `npm install --save-dev @types/node @types/express` -> `[{ ecosystem: "npm", name: "@types/node", version: "unknown" }, { ecosystem: "npm", name: "@types/express", version: "unknown" }]`

### Socket API Call

POST to `https://api.socket.dev/v0/purl?alerts=true&compact=true`:

```json
{
  "components": [
    { "purl": "pkg:npm/express@4.18.2" },
    { "purl": "pkg:pypi/requests" }
  ]
}
```

Headers:
```
Authorization: Bearer $SOCKET_API_KEY
Content-Type: application/json
Accept: application/x-ndjson
User-Agent: socket-gate/0.1.0
```

The API key comes from `$SOCKET_API_KEY` environment variable. If unset, the hook should allow the command (fail open) and print a warning to stderr.

### PURL Construction Rules

- Strip `^`, `~`, `>=`, `<=`, `==`, `>`, `<`, `!=` prefixes from version strings
- If version is empty, `unknown`, or `1.0.0`, omit the `@version` suffix
- Scoped npm packages: `@scope/name` becomes `pkg:npm/%40scope/name` (URL-encode the `@`)
- PyPI packages: normalize name to lowercase, replace `-` and `.` with `-` (PEP 503)

### Decision Logic

Parse the NDJSON response. For each package, extract:
- `score.supply_chain` (0.0-1.0)
- `score.quality` (0.0-1.0)
- `score.vulnerability` (0.0-1.0)
- `score.maintenance` (0.0-1.0)
- `score.license` (0.0-1.0)

**Default behavior:** Block only known malware (supply_chain score of 0). Warn on low scores. This avoids false positives from packages that are legitimate but poorly maintained or old.

| Condition | Action | Env Override |
|-----------|--------|--------------|
| supply_chain = 0 | Block | `SOCKET_GATE_BLOCK_THRESHOLD` (default: `0`) |
| supply_chain < 0.4 | Warn (context injected, not blocked) | `SOCKET_GATE_WARN_THRESHOLD` (default: `0.4`) |

Additional environment variables:
- `SOCKET_GATE_MODE`: `enforce` (default), `warn`, `off`
  - `enforce`: block known malware, warn on low scores (exit 2 / exit 0 with context)
  - `warn`: warn on everything, never block (exit 0 with context)
  - `off`: pass through everything
- `SOCKET_GATE_FAIL_BEHAVIOR`: `open` (default), `closed`
  - `open`: if the API is unreachable or returns an error, allow the install
  - `closed`: if the API is unreachable, block the install

### Output Contract

**Pass-through (no install command detected):**
```
exit 0
```
No stdout. No API call made. Zero latency added.

**Allow (scores pass):**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "additionalContext": "Socket: express@4.18.2 passed (supply_chain=92, quality=88, vulnerability=100, maintenance=95)"
  }
}
```
Exit 0. Command proceeds. Score context is injected into the AI's conversation so it has visibility into the check.

**Block (known malware, supply_chain = 0):**

Stderr message (shown to Claude as error context):
```
Socket security check BLOCKED: malicious-pkg@2.0.0
  supply_chain: 0 (known malware)

Blocked by socket-gate. This package is flagged as malicious.
Do NOT install it. Find an alternative.
```
Exit 2. Command does not execute.

**Warn (low scores, not blocked):**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "additionalContext": "Socket WARNING: colors@1.4.0 has low supply_chain score (42). 2 alerts found. Proceed with caution."
  }
}
```
Exit 0. Command proceeds, but the AI sees the warning and can decide to abort.

**API failure (fail-open mode):**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "additionalContext": "Socket: API check failed (timeout). Install allowed under fail-open policy."
  }
}
```
Exit 0. Stderr: `socket-gate: Socket API unreachable, allowing install (fail-open mode)`.

### Implementation Language

Shell script (bash). No compilation step. No runtime dependencies beyond `curl` and `jq`.

The script should be:
- Vendored in the `socket-mcp` repo under `hooks/socket-gate.sh`
- Published to npm as part of `@socketsecurity/mcp` (accessible via `npx`)
- Also installable standalone via curl

### File Layout

```
hooks/
├── socket-gate.sh          # Main hook script
├── socket-gate-test.sh     # Test suite (bats or plain bash assertions)
├── parsers/
│   ├── npm.sh              # npm/pnpm/yarn command parser
│   ├── pip.sh              # pip/uv/poetry command parser
│   ├── cargo.sh            # cargo command parser
│   ├── go.sh               # go get/install parser
│   └── generic.sh          # Fallback/shared utilities
└── README.md               # Hook-specific docs
```

---

## Component 2: CLAUDE.md Directives

### Purpose

Soft enforcement. The hook handles the hard gate. CLAUDE.md instructions shape AI behavior so it proactively uses Socket MCP tools and prefers safer patterns. These directives work in any MCP-capable AI tool that reads project instructions.

### Recommended CLAUDE.md Content

Ship as a copyable block in the socket-mcp README and as a file at `templates/CLAUDE.md` in the repo.

```markdown
## Package Security (Socket)

### Rules
- Before installing any package, check it with the `check_package` MCP tool.
  Pass the ecosystem, package name, and version. If version is unknown, use "unknown".
- If the verdict is FAIL, do NOT install the package. Suggest alternatives.
- If the verdict is WARN, inform the user of the risks before proceeding.
- When adding imports to source code, also check those packages with `check_package`.
  Imports indicate dependencies even if they aren't in the manifest yet.
- When writing code that introduces a new dependency, check it BEFORE writing the
  import statement.
- Use `batch_check` when adding multiple packages at once (more efficient than
  individual `check_package` calls).

### Available MCP Tools
- `check_package`: Single package check with verdict (PASS/WARN/FAIL), scores, and alerts
- `batch_check`: Check multiple packages at once with scores and alerts
- `explain_alert`: Get plain-language explanation of a Socket alert type
```

### Placement Options

1. **Project-level** (`.claude/CLAUDE.md`): Best for teams. Committed to git. Every developer using Claude Code on the project gets the directives.
2. **User-global** (`~/.claude/CLAUDE.md`): Applies across all projects for one user. Append the rules, don't overwrite existing content.
3. **MCP server resource**: Expose the directives as an MCP resource that clients can fetch. Most portable option for non-Claude tools.

---

## Component 3: Expanded MCP Tools

### Current State

The MCP server has one tool: `depscore`. It calls `/v0/purl` with `alerts=false` and returns only numeric scores. No alerts. No verdicts. No actionable guidance.

### New Tools

#### 3.1 `check_package`

Single-package check with rich, actionable output. Calls `/v0/purl` with `alerts=true&compact=true`.

**Input:**
```typescript
z.object({
  ecosystem: z.string().default('npm'),
  name: z.string(),
  version: z.string().default('unknown'),
})
```

**Output (structured text):**
```
Package: pkg:npm/colors@1.4.0
Verdict: WARN

Scores:
  supply_chain: 42 (low)
  quality: 65
  vulnerability: 100
  maintenance: 30 (low)
  license: 100

Alerts (2):
  - HIGH: protestware - Package maintainer added malicious code in v1.4.1
  - MEDIUM: unmaintained - No commits in 2+ years

```

**Verdict logic:**
- `FAIL`: supply_chain score = 0 (known malware)
- `WARN`: supply_chain score < 0.4, or HIGH/CRITICAL alerts present
- `PASS`: everything else

Differs from `depscore`:
- Single package input (simpler for the common "should I install this?" question)
- Includes alerts with severity and description
- Provides a clear verdict: `PASS`, `WARN`, `FAIL`

#### 3.2 `batch_check` (evolution of `depscore`)

Keep the existing batch-check functionality but with alerts and verdicts. This is the bulk version of `check_package`.

**Input:**
```typescript
z.object({
  packages: z.array(z.object({
    ecosystem: z.string().default('npm'),
    name: z.string(),
    version: z.string().default('unknown'),
  })),
})
```

**Output:** Same NDJSON parsing as current `depscore`, but with alerts appended per package and a summary verdict per package.

```
Dependency check results:

pkg:npm/express@4.18.2: PASS
  supply_chain=92, quality=88, vulnerability=100, maintenance=95

pkg:npm/colors@1.4.0: WARN
  supply_chain=42, quality=65, vulnerability=100, maintenance=30
  Alerts: HIGH protestware, MEDIUM unmaintained

Summary: 1 passed, 1 warning, 0 failed
```

#### 3.3 `explain_alert`

Given a Socket alert type, return a plain-language explanation. No API call needed; static knowledge base bundled with the server.

**Input:**
```typescript
z.object({
  alert_type: z.string().describe('Socket alert type (e.g., "protestware", "installScripts", "networkAccess", "typosquat")'),
})
```

**Output:**
```
Alert: installScripts
Severity: MEDIUM
Category: Supply Chain

What: This package runs scripts during installation (preinstall, postinstall, etc.).
Why it matters: Install scripts execute arbitrary code the moment you run npm install,
before you ever import the package. Malicious packages use this for cryptominers,
credential theft, and backdoors.
What to do: Review the scripts in package.json. If the package doesn't need install
scripts for native compilation or similar, consider using --ignore-scripts or
choosing an alternative.
```

**Knowledge base coverage** (minimum set for v1):

| Alert Type | Category |
|------------|----------|
| `typosquat` | Supply Chain |
| `protestware` | Supply Chain |
| `installScripts` | Supply Chain |
| `networkAccess` | Supply Chain |
| `shellAccess` | Supply Chain |
| `filesystemAccess` | Supply Chain |
| `envVariableAccess` | Supply Chain |
| `unmaintained` | Maintenance |
| `deprecated` | Maintenance |
| `noLicense` | License |
| `copyleftLicense` | License |
| `nonpermissiveLicense` | License |
| `knownVulnerability` | Vulnerability |
| `criticalCVE` | Vulnerability |
| `highCVE` | Vulnerability |
| `obfuscatedCode` | Malware |
| `suspiciousString` | Malware |
| `dynamicRequire` | Quality |
| `noTests` | Quality |
| `noREADME` | Quality |
| `tooManyDependencies` | Quality |

Returns "Unknown alert type" with a suggestion to check Socket docs for unrecognized types.

### Deprecation of `depscore`

`depscore` stays as an alias for `batch_check` for backward compatibility. Tool description updated to say "Deprecated: use batch_check instead." Remove after two minor versions.

### API Parameter Changes

Change the base PURL query parameters from:
```
alerts=false&compact=false&fixable=false&licenseattrib=false&licensedetails=false
```
To:
```
alerts=true&compact=true
```

Alerts are the most actionable data the API returns. Suppressing them removes the context the AI needs to make informed decisions.

---

## Distribution and Setup

### One-Line Setup (Claude Code)

```bash
npx @socketsecurity/mcp@latest --setup-claude-code
```

This command should:
1. Check for `SOCKET_API_KEY` in environment, prompt if missing
2. Add the MCP server to `~/.claude/settings.json` under `mcpServers`
3. Copy `socket-gate.sh` to `~/.claude/hooks/socket-gate.sh`
4. Add the PreToolUse hook configuration to `~/.claude/settings.json`
5. Print the recommended CLAUDE.md snippet for the user to add to their project

### Manual Setup

For users who want granular control:

**Step 1: MCP Server**
```bash
claude mcp add socket -e SOCKET_API_KEY="$SOCKET_API_KEY" -- npx -y @socketsecurity/mcp@latest
```

Or use the public hosted server (no API key needed for score checks):
```json
{
  "mcpServers": {
    "socket": {
      "type": "http",
      "url": "https://mcp.socket.dev/"
    }
  }
}
```

**Step 2: Hook**
```bash
curl -sL https://raw.githubusercontent.com/SocketDev/socket-mcp/main/hooks/socket-gate.sh \
  -o ~/.claude/hooks/socket-gate.sh
chmod +x ~/.claude/hooks/socket-gate.sh
```

Add to `.claude/settings.json`:
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/socket-gate.sh",
            "timeout": 30,
            "statusMessage": "Checking packages with Socket..."
          }
        ]
      }
    ]
  }
}
```

**Step 3: CLAUDE.md**

Copy the directive block from Component 2 into `.claude/CLAUDE.md` or `~/.claude/CLAUDE.md`.

### Docker / CI

For CI environments where Claude Code or similar tools run autonomously:

```bash
export SOCKET_API_KEY="$SOCKET_API_KEY"
export SOCKET_GATE_MODE="enforce"
export SOCKET_GATE_FAIL_BEHAVIOR="closed"  # Block on API failure in CI
```

---

## Interaction Between Components

The three components form two layers of defense:

```
Layer 1 (soft): CLAUDE.md directives + MCP tools
  AI checks packages proactively via check_package/batch_check
  AI sees scores, alerts, verdicts before deciding to install
  ↓ (AI might skip this)

Layer 2 (hard): PreToolUse hook (socket-gate)
  Intercepts raw install commands regardless of AI behavior
  Checks scores via Socket API, blocks if risky
  ↓ (if allowed)

Package manager executes install
```

Each component works independently:
- **Hook alone**: enforcement without AI cooperation
- **CLAUDE.md alone**: AI cooperation without enforcement
- **MCP tools alone**: on-demand checking, no enforcement
- **Hook + CLAUDE.md + MCP tools**: full coverage

---

## Security Considerations

### Fail Open vs. Fail Closed

Default: fail open. If the Socket API is unreachable, the hook allows the install. Rationale: developer velocity shouldn't be blocked by API outages. CI environments should set `SOCKET_GATE_FAIL_BEHAVIOR=closed`.

### API Key Exposure

The hook reads `SOCKET_API_KEY` from the environment. Claude Code's hook system passes environment variables from the parent shell. The API key is never written to disk by the hook, never logged, and never included in hook output JSON.

### Command Injection

The hook parses `tool_input.command` from JSON stdin using `jq`. It does NOT evaluate or execute the command string. Package names extracted from the command are URL-encoded before inclusion in PURL strings. The hook only makes outbound HTTPS requests to `api.socket.dev`.

### Bypass

A determined user can:
- Set `SOCKET_GATE_MODE=off`
- Remove the hook from settings

This is intentional. The hook is a safety net for AI-driven installs, not a lockdown mechanism.

---

## File Structure (Full Project)

```
socket-mcp/
├── index.ts                      # MCP server (updated with new tools)
├── tools/
│   ├── check-package.ts          # check_package tool implementation
│   ├── batch-check.ts            # batch_check tool (refactored depscore)
│   ├── explain-alert.ts          # explain_alert tool implementation
│   └── alerts-knowledge.ts       # Static alert type definitions
├── hooks/
│   ├── socket-gate.sh            # PreToolUse hook script
│   ├── parsers/
│   │   ├── npm.sh
│   │   ├── pip.sh
│   │   ├── cargo.sh
│   │   ├── go.sh
│   │   └── generic.sh
│   └── test/
│       ├── socket-gate-test.sh
│       └── fixtures/             # Test input JSON fixtures
├── templates/
│   ├── CLAUDE.md                 # Recommended CLAUDE.md directives
│   ├── settings-hook.json        # Hook configuration snippet
│   └── settings-mcp.json         # MCP server configuration snippet
├── scripts/
│   ├── setup-claude-code.ts      # --setup-claude-code implementation
│   ├── check-versions.ts         # (existing)
│   └── clean.sh                  # (existing)
├── package.json
├── tsconfig.json
├── manifest.json
├── RFC.md                        # This document
└── README.md                     # Updated with setup instructions
```

---

## Implementation Order

### Phase 1: Hook (socket-gate)

Highest impact, lowest coupling. Works independently of MCP server changes.

1. Build the command parser for npm ecosystem (most common)
2. Wire up Socket API call with PURL construction
3. Implement decision logic with threshold checking
4. Add parsers for pip, cargo, go
5. Write test suite with fixture-based input/output assertions
6. Test in Claude Code with real sessions

**Acceptance criteria:**
- `npm install malicious-pkg` with supply_chain = 0 is blocked
- `npm install sketchy-pkg` with supply_chain = 0.3 is warned (not blocked)
- `npm install express` is allowed
- `pip install requests flask` checks both packages
- Missing `SOCKET_API_KEY` fails open with stderr warning
- Commands without install operations pass through with exit 0 (no API call, no latency)
- Latency < 3s for single package checks
- No dependency on Socket CLI

### Phase 2: CLAUDE.md + Templates

1. Write the CLAUDE.md directive content
2. Create settings.json template snippets
3. Build `--setup-claude-code` CLI command
4. Update README with setup documentation

**Acceptance criteria:**
- One-liner setup works on macOS and Linux
- CLAUDE.md directives cause Claude Code to call `check_package` before installing packages (verified in manual testing)
- Setup does not overwrite existing user settings
- All referenced tools are MCP tools, not CLI commands

### Phase 3: Expanded MCP Tools

1. Refactor `depscore` into `batch_check` with alerts and verdicts
2. Build `check_package` tool
3. Build `explain_alert` with static knowledge base
4. Update manifest.json with new tool definitions

**Acceptance criteria:**
- `check_package` returns verdict + alerts for any package
- `explain_alert` covers all alert types in the knowledge base table
- Backward compatibility: `depscore` still works (aliases to `batch_check`)
- All tools call Socket API directly (no CLI subprocess)

---

## Resolved Decisions

1. **Alert knowledge base: static.** Bundled in `alerts-knowledge.ts`, updated on each npm release. Falls back to "Unknown alert type, see Socket docs" for unrecognized types. No runtime API dependency.

2. **Hook blocks only known malware (supply_chain = 0).** Low scores get a warning injected into context, not a hard block. This avoids false positives from legitimate packages that are old or poorly maintained. Threshold is configurable via `SOCKET_GATE_BLOCK_THRESHOLD` for users who want stricter enforcement.

3. **Deploy all new tools to mcp.socket.dev.** `check_package`, `batch_check`, and `explain_alert` are all stateless. No reason to withhold them from the public server.

4. **No alternative package suggestions.** `check_package` does not suggest replacements. No Socket API endpoint for this, and hardcoded swaps go stale. The AI can research alternatives on its own when a package fails checks.
