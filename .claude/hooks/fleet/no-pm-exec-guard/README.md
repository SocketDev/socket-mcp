# no-pm-exec-guard

PreToolUse(Bash) hook that blocks `pnpm exec` / `npm exec` / `yarn exec`.

## What it catches

A Bash command that invokes `<pm> exec <tool>` for `pm ∈ {pnpm, npm, yarn}`,
detected by AST-parsing the command (`shell-command.mts/findInvocation`), so it
matches across pipes / `&&` chains / leading env vars and never false-matches a
substring.

## Why

`pnpm exec <tool>` runs an already-installed `node_modules/.bin` binary, but
wraps it in the package manager's startup + (in this fleet) the Socket Firewall
interception layer on every call — pure overhead. During the 2026-06-03
slowdown investigation, bare `node_modules/.bin/tsgo` ran in 422ms vs the
multi-second `pnpm exec tsgo`.

Run the bin directly (`node_modules/.bin/<tool>`) or via `pnpm run <script>`.

## Not the same as no-npx-dlx

`pnpm dlx` / `npx <pkg>` / `yarn dlx` **fetch + execute** unpinned code — a
supply-chain risk, banned by `no-npx-dlx`. `pnpm exec` only runs an
already-installed bin — an overhead/consistency concern. Both are banned, by
separate rules.

## Bypass

Type `Allow pm-exec bypass` in a recent turn.

## Exit codes

- `0` — pass (not Bash, no `<pm> exec`, or bypassed)
- `2` — block
- Fails open on any internal error.
