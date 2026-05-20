/**
 * @fileoverview Test runner — accepts `--staged` / `--fast` from the
 * fleet pre-commit hook and forwards to the test sub-scripts. `--staged`
 * is the pre-commit signal; `--fast` skips the embedded lint pass since
 * the hook runs lint separately. Both are silently ignored here — the
 * granular test scripts (test:tsc, test:node-test) don't understand
 * them, but the pre-commit hook always passes one or both.
 */

import { spawnSync } from '@socketsecurity/lib-stable/spawn'
import process from 'node:process'

const args = process.argv.slice(2)
const isFast = args.includes('--fast')
const isStaged = args.includes('--staged')
// On Windows, `pnpm` is a .cmd shim that can't be invoked without a shell.
const useShell = process.platform === 'win32'

function run(script: string, label: string): number {
  const r = spawnSync('pnpm', ['run', script], {
    shell: useShell,
    stdio: 'inherit',
  })
  if (r.status !== 0) {
    console.error(`${label} failed`)
    return 1
  }
  return 0
}

let exitCode = 0

exitCode = run('test:tsc', 'test:tsc') || exitCode

if (!isFast && !isStaged) {
  exitCode = run('test:node-test', 'test:node-test') || exitCode
}

process.exitCode = exitCode
