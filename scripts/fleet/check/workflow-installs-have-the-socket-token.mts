#!/usr/bin/env node
/*
 * @file `check --all` gate: every workflow step that runs a fleet setup
 *   composite can see the Socket API token, so the firewall and CLI are
 *   authenticated during install.
 *
 *   ONE org secret is the source — `SOCKET_API_TOKEN_FOR_CLI_AND_SFW` — and
 *   the setup action exports its value under BOTH env names consumers read:
 *   `SOCKET_API_TOKEN` for the CLI and `SOCKET_API_KEY` for sfw and the
 *   dev-machine keychain. That dual naming is what the secret's own name
 *   records, and it is why no member needs a repo-level copy of either.
 *
 *   A workflow supplies it one of two ways, and both count:
 *     1. `socket-api-token:` on the setup step, or
 *     2. `SOCKET_API_KEY:` as job/workflow env, which the composite's own run
 *        steps inherit.
 *
 *   Supplying NEITHER is the failure this catches, and it is quiet: the
 *   install still succeeds, the firewall just runs unauthenticated, so the
 *   run is green while the protection it exists for is off. prune-workflow-runs
 *   shipped that way — every sibling had one of the two forms and it had
 *   neither, which no amount of reading a single file would have surfaced.
 *
 *   Exit: 0 — every setup step is covered, or none exists; 1 — a step can see
 *   no token.
 *
 *   Usage: node scripts/fleet/check/workflow-installs-have-the-socket-token.mts [--quiet]
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'

import { REPO_ROOT } from '../paths.mts'
import { isMainModule } from '../_shared/is-main-module.mts'
import { runMain } from '../_shared/run-main.mts'

import type { ScriptMeta } from '../_shared/run-main.mts'

const logger = getDefaultLogger()

/**
 * The org secret every form must ultimately read.
 */
export const ORG_TOKEN_SECRET = 'SOCKET_API_TOKEN_FOR_CLI_AND_SFW'

/**
 * The setup composites whose install path authenticates against Socket.
 */
export const SETUP_COMPOSITES: readonly string[] = [
  './.github/actions/fleet/setup',
  './.github/actions/fleet/setup-and-install',
]

/**
 * True when `text` supplies the Socket token by either sanctioned form — the
 * step input or inherited job env. Pure; exported for tests.
 */
export function suppliesSocketToken(text: string): boolean {
  return (
    text.includes(`socket-api-token: \${{ secrets.${ORG_TOKEN_SECRET}`) ||
    text.includes(`SOCKET_API_KEY: \${{ secrets.${ORG_TOKEN_SECRET}`)
  )
}

/**
 * True when `text` runs a fleet setup composite at all. Pure; exported for
 * tests.
 */
export function runsSetupComposite(text: string): boolean {
  for (let i = 0, { length } = SETUP_COMPOSITES; i < length; i += 1) {
    // The trailing boundary matters: `setup-and-install` and `setup-odai` both
    // start with `setup`, and only the first authenticates against Socket.
    const uses = `uses: ${SETUP_COMPOSITES[i]!}`
    if (
      text.includes(`${uses}\n`) ||
      text.includes(`${uses}\r\n`) ||
      text.endsWith(uses)
    ) {
      return true
    }
  }
  return false
}

/**
 * The workflow basenames under `dir` that run a setup composite without
 * supplying the token by either form.
 */
export function unauthenticatedWorkflows(dir: string): string[] {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const out: string[] = []
  const sorted = entries.toSorted()
  for (let i = 0, { length } = sorted; i < length; i += 1) {
    const name = sorted[i]!
    if (!name.endsWith('.yml') && !name.endsWith('.yaml')) {
      continue
    }
    try {
      const text = readFileSync(path.join(dir, name), 'utf8')
      if (runsSetupComposite(text) && !suppliesSocketToken(text)) {
        out.push(name)
      }
    } catch {
      // Fail-open per file — an unreadable workflow is not evidence.
    }
  }
  return out
}

export function main(): number {
  const quiet = process.argv.includes('--quiet')
  const offenders = unauthenticatedWorkflows(
    path.join(REPO_ROOT, '.github', 'workflows'),
  )
  if (offenders.length) {
    logger.fail(
      '[workflow-installs-have-the-socket-token] workflow(s) install with NO Socket token:',
    )
    logger.error(
      `  What:   ${offenders.length} workflow(s) run a fleet setup composite without the token, so the firewall runs unauthenticated while the job still reports green.`,
    )
    logger.error('  Where:  the workflow(s) below.')
    logger.error('  Saw:    neither form present:')
    for (let i = 0, { length } = offenders; i < length; i += 1) {
      logger.error(`    x ${offenders[i]!}`)
    }
    logger.error(
      `  Fix:    add EITHER \`socket-api-token: \${{ secrets.${ORG_TOKEN_SECRET} }}\` to the setup step, OR \`SOCKET_API_KEY: \${{ secrets.${ORG_TOKEN_SECRET} }}\` as job env. One org secret feeds both env names.`,
    )
    return 1
  }
  if (!quiet) {
    logger.success(
      '[workflow-installs-have-the-socket-token] every fleet setup step can see the Socket token.',
    )
  }
  return 0
}

const SCRIPT_META: ScriptMeta = {
  describe:
    'every workflow running a fleet setup composite supplies the Socket API token',
  help: `Usage: node scripts/fleet/check/workflow-installs-have-the-socket-token.mts [flags]

  --quiet   print nothing when every workflow carries the token`,
}

/* c8 ignore start - entry-point wiring, exercised by running the script. */
if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}
/* c8 ignore stop */
