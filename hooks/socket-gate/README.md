# socket-gate

A Claude Code `PreToolUse` hook you can copy into your own setup to block
high-risk package installs before they run. When Claude Code is about to
execute a `Bash` install command, the hook queries the public Socket MCP server
at `https://mcp.socket.dev/` and denies the install when the package's supply
chain score is below `20` (known malware, typosquats, high-risk supply chain
signals).

No API key, no CLI, no registration. Copy the directory and wire it up.

This directory holds the hook source (`index.mts`) plus the bundled
`socket-gate.cjs` that a build produces. You copy the whole directory into
`~/.claude/hooks/` and point your settings at the `.cjs` (see
[Copy it in](#copy-it-in)).

## Why

A package install is the moment a supply chain attack lands. Catching a
typosquat or known-malware package at the `PreToolUse` boundary, before the
install command runs, stops it from reaching disk or firing a postinstall
script. The hook is an advisory guardrail: it fails open, so a Socket outage
never blocks legitimate work.

## What it catches

Install commands across six ecosystems, parsed out of the `Bash` tool's command
string:

| Ecosystem | Commands                                                                                  |
| --------- | ----------------------------------------------------------------------------------------- |
| npm       | `npm install`, `npm i`, `npm add`, `yarn add`, `pnpm add`, `bun add`                      |
| PyPI      | `pip install`, `pip3 install`, `uv add`, `uv pip install`, `poetry add`, `pipenv install` |
| Cargo     | `cargo add`, `cargo install`                                                              |
| RubyGems  | `gem install`, `bundle add`                                                               |
| Go        | `go get`, `go install`                                                                    |
| NuGet     | `dotnet add package`, `nuget install`                                                     |

For a matched package the hook calls the Socket MCP `depscore` tool, parses the
`supplyChain` score, and denies when `supplyChain < 20`. Everything else
allows.

## Copy it in

Copy the whole `socket-gate` directory into your hooks folder so the bundle and
its docs travel together, and so you own your copy to edit. The bundled
`socket-gate.cjs` is self-contained: rolldown inlines its one dependency
(`@socketsecurity/lib-stable`), so it runs without a `package.json` or
`node_modules` beside it.

From an installed `@socketsecurity/mcp` package:

```bash
mkdir -p ~/.claude/hooks
cp -R node_modules/@socketsecurity/mcp/hooks/socket-gate ~/.claude/hooks/
```

From a checkout of this repo, run `pnpm run build` first to produce
`socket-gate.cjs`, then copy:

```bash
pnpm run build
cp -R hooks/socket-gate ~/.claude/hooks/
```

## Wire it up

Add to `~/.claude/settings.json`:

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

## How it works

`supplyChain < 20` denies, anything else allows — e.g. `express` / `lodash` /
`react` (75–97) allow, `browserlist` (typosquat of `browserslist`, 15) and
confirmed malware (0) block. Network, timeout, and parse errors all fail open
(decision `allow`), with the cause written to stderr; stdout stays the
allow/deny IPC channel Claude Code parses.

## Limitations

A best-effort guardrail, not a complete defense. Known gaps:

- **Manifest edits + lockfile installs.** Editing a manifest (`package.json`,
  `requirements.txt`, `Cargo.toml`, `Gemfile`, `go.mod`, `*.csproj`) then
  running a bare install (`npm install`, `pip install -r requirements.txt`,
  `cargo build`, `bundle install`, `go mod tidy`, `dotnet restore`) leaves no
  package name on the command line to check.
- **Package-manager invocations only.** Direct downloads (`curl | sh`,
  `wget`), postinstall scripts of already-accepted packages, and transitive
  dependencies are not re-checked.
- **Indirect Claude paths.** Sub-agents, MCP tools that shell out, and
  non-`Bash` tool calls are not covered unless the `matcher` is broadened.

## Test

The unit tests run against the `.mts` source (not the bundle):

```bash
pnpm test
```
