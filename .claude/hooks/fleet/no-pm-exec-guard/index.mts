#!/usr/bin/env node
// Claude Code PreToolUse(Bash) hook — no-pm-exec-guard.
//
// Blocks `pnpm exec` / `npm exec` / `yarn exec`. These run an already-installed
// `node_modules/.bin` binary, but wrap it in the package manager's startup +
// (in this fleet) the Socket Firewall interception layer on every call — pure
// overhead. `bare node_modules/.bin/tsgo` ran in 422ms vs the multi-second
// `pnpm exec tsgo` wrapper during the 2026-06-03 slowdown investigation.
//
// Run the bin directly (`node_modules/.bin/<tool>`) or via `pnpm run <script>`.
//
// NOT the same as the dlx/npx ban (no-npx-dlx): `pnpm dlx`/`npx`/`yarn dlx`
// FETCH + execute unpinned code (a supply-chain risk); `pnpm exec` only runs an
// installed bin (an overhead/consistency concern). Both are banned, separately.
//
// AST-parses the command via shell-command.mts/findInvocation (per the
// no-command-regex-in-hooks rule) — never a raw regex on the command string.
//
// Bypass: `Allow pm-exec bypass` in a recent user turn.
//
// Exit codes: 0 — pass; 2 — block. Fails open on any throw.

import process from 'node:process'

import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'

import { withBashGuard } from '../_shared/payload.mts'
import { findInvocation } from '../_shared/shell-command.mts'
import { bypassPhrasePresent } from '../_shared/transcript.mts'

const logger = getDefaultLogger()

const BYPASS_PHRASE = 'Allow pm-exec bypass'

// (binary, label) pairs whose `exec` subcommand is banned.
const PM_EXEC: ReadonlyArray<readonly [string, string]> = [
  ['pnpm', 'pnpm exec'],
  ['npm', 'npm exec'],
  ['yarn', 'yarn exec'],
]

export function bannedPmExec(command: string): string | undefined {
  for (let i = 0, { length } = PM_EXEC; i < length; i += 1) {
    const [binary, label] = PM_EXEC[i]!
    if (findInvocation(command, { binary, subcommand: 'exec' })) {
      return label
    }
  }
  return undefined
}

void (async () => {
  await withBashGuard((command, payload) => {
    const label = bannedPmExec(command)
    if (!label) {
      return
    }
    if (bypassPhrasePresent(payload.transcript_path, BYPASS_PHRASE)) {
      return
    }
    logger.error(
      [
        `[no-pm-exec-guard] Blocked: \`${label}\`.`,
        '',
        `  \`${label} <tool>\` wraps the installed bin in package-manager +`,
        '  Socket Firewall startup overhead on every call.',
        '',
        '  Run the bin directly, or via a script:',
        `    node_modules/.bin/<tool>      not  ${label} <tool>`,
        '    pnpm run <script>',
        '',
        `  (Distinct from dlx/npx, which FETCH code — see no-npx-dlx.)`,
        `  Bypass: type \`${BYPASS_PHRASE}\` if this is genuinely intended.`,
        '',
      ].join('\n'),
    )
    process.exitCode = 2
  })
})()
