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

import { execSync } from 'node:child_process'
import process from 'node:process'

const args = process.argv.slice(2)
const forwardedArgs = args.filter(
  a => a === '--all' || a === '--fix' || a === '--quiet' || a === '--staged',
)

try {
  const lintArgs = forwardedArgs.length ? ' ' + forwardedArgs.join(' ') : ''
  execSync(`node scripts/lint.mts${lintArgs}`, { stdio: 'inherit' })
  execSync('pnpm exec tsgo --noEmit -p tsconfig.json', {
    stdio: 'inherit',
  })
} catch {
  process.exitCode = 1
}
