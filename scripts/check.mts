/**
 * @fileoverview Unified check runner — delegates to lint + type check.
 *
 * Forwards CLI scope flags to the lint script so `pnpm run check --all`
 * actually runs a full-scope lint (not the default modified-only scope).
 * `pnpm type` doesn't accept our scope flags, so it's always a full
 * check.
 *
 * Usage:
 *   pnpm run check              # lint in modified scope + full type check
 *   pnpm run check --staged     # lint staged + full type
 *   pnpm run check --all        # full lint + full type (CI)
 */

import { spawnSync } from '@socketsecurity/lib-stable/spawn'
import process from 'node:process'

const args = process.argv.slice(2)
const forwardedArgs = args.filter(
  a => a === '--all' || a === '--fix' || a === '--quiet' || a === '--staged',
)

function run(cmd: string, cmdArgs: string[]): number {
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit' })
  return r.status ?? 1
}

const lintStatus = run('node', ['scripts/lint.mts', ...forwardedArgs])
if (lintStatus !== 0) {
  process.exitCode = lintStatus
} else {
  const tscStatus = run('pnpm', [
    'exec',
    'tsgo',
    '--noEmit',
    '-p',
    'tsconfig.json',
  ])
  if (tscStatus !== 0) {
    process.exitCode = tscStatus
  }
}
