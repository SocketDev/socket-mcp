/**
 * @fileoverview Test runner — accepts `--staged` / `--fast` from the
 * fleet pre-commit hook and forwards to the test sub-scripts. `--staged`
 * is the pre-commit signal; `--fast` skips the embedded lint pass since
 * the hook runs lint separately. Both are silently ignored here — the
 * granular test scripts (test:tsc, test:node-test) don't understand
 * them, but the pre-commit hook always passes one or both.
 */

import { execSync } from 'node:child_process'
import process from 'node:process'

const args = process.argv.slice(2)
const isFast = args.includes('--fast')
const isStaged = args.includes('--staged')

function run(cmd: string, label: string): number {
  try {
    execSync(cmd, { stdio: 'inherit' })
    return 0
  } catch {
    console.error(`${label} failed`)
    return 1
  }
}

let exitCode = 0

// Always type-check (it's fast and catches a lot).
exitCode = run('pnpm run test:tsc', 'test:tsc') || exitCode

// On pre-commit, skip node-test (it spawns the server + needs an API
// key). `--staged` / `--fast` signal pre-commit mode.
if (!isFast && !isStaged) {
  exitCode = run('pnpm run test:node-test', 'test:node-test') || exitCode
}

process.exitCode = exitCode
