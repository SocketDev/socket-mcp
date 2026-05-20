/**
 * @fileoverview Canonical minimal lint runner for socket-* repos.
 *
 * Scope modes:
 *   (default)   Lint files modified in the working tree vs HEAD.
 *   --staged    Lint files in the git index (used by .husky/pre-commit).
 *   --all       Lint the entire workspace.
 *
 * Flags:
 *   --fix       Auto-fix issues.
 *   --quiet     Suppress progress output.
 *
 * If the chosen scope has no lintable files, the script is a no-op.
 *
 * Config or infrastructure changes (.config/oxlintrc.json,
 * .config/oxfmtrc.json, tsconfig*.json, pnpm-lock.yaml, .config/**,
 * scripts/**, package.json) escalate to `--all` automatically, since they
 * can affect everything.
 *
 * This is the minimal zero-dependency reference implementation. Larger repos
 * (socket-lib, socket-registry, socket-sdk-js, etc.) use a richer version
 * based on @socketsecurity/lib helpers; this one keeps the same CLI
 * contract so pre-commit hooks and CI work identically across repos.
 */

import { spawnSync } from '@socketsecurity/lib-stable/spawn'
import type { SpawnSyncOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { getDefaultLogger } from '@socketsecurity/lib/logger'

const logger = getDefaultLogger()

const args = process.argv.slice(2)
const mode: 'staged' | 'all' | 'modified' = args.includes('--all')
  ? 'all'
  : args.includes('--staged')
    ? 'staged'
    : 'modified'
const fix = args.includes('--fix')
const quiet = args.includes('--quiet') || args.includes('--silent')
const stdio: SpawnSyncOptions['stdio'] = quiet ? 'pipe' : 'inherit'

const LINTABLE_EXTS = new Set(['.cjs', '.cts', '.js', '.mjs', '.mts', '.ts'])

// Paths that, when touched, force a full-workspace lint.
const ESCALATION_PATTERNS = [
  /^\.config\//,
  /^scripts\//,
  /^pnpm-lock\.yaml$/,
  /^tsconfig.*\.json$/,
  /^package\.json$/,
  /^lockstep\.schema\.json$/,
]

function log(msg: string): void {
  if (!quiet) {
    logger.log(msg)
  }
}

function gitFiles(gitArgs: string[]): string[] {
  const r = spawnSync('git', gitArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    stdioString: true,
  })
  if (r.status !== 0 || typeof r.stdout !== 'string') {
    return []
  }
  return r.stdout
    .split('\n')
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

function getStagedFiles(): string[] {
  return gitFiles(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
}

function getModifiedFiles(): string[] {
  return gitFiles(['diff', '--name-only', '--diff-filter=ACMR', 'HEAD'])
}

function shouldEscalate(files: string[]): boolean {
  for (let i = 0, { length } = files; i < length; i += 1) {
    const f = files[i]
    for (let j = 0, { length: pLen } = ESCALATION_PATTERNS; j < pLen; j += 1) {
      if (ESCALATION_PATTERNS[j].test(f)) {
        return true
      }
    }
  }
  return false
}

function filterLintable(files: string[]): string[] {
  return files.filter(f => LINTABLE_EXTS.has(path.extname(f)) && existsSync(f))
}

function runAll(): number {
  log('Formatting all files...')
  const fmt = spawnSync(
    'pnpm',
    [
      'exec',
      'oxfmt',
      '-c',
      '.config/oxfmtrc.json',
      fix ? '--write' : '--check',
      '.',
    ],
    { stdio },
  )
  if (fmt.status !== 0) {
    return 1
  }
  log('Running oxlint on all files...')
  const lintArgs = ['exec', 'oxlint', '-c', '.config/oxlintrc.json']
  if (fix) {
    lintArgs.push('--fix')
  }
  const lint = spawnSync('pnpm', lintArgs, { stdio })
  if (lint.status !== 0) {
    return 1
  }
  return 0
}

function runFiles(files: string[]): number {
  if (files.length === 0) {
    log('No lintable files; skipping.')
    return 0
  }
  log(`Formatting ${files.length} file(s)...`)
  const oxfmtArgs = [
    'exec',
    'oxfmt',
    '-c',
    '.config/oxfmtrc.json',
    fix ? '--write' : '--check',
    '--no-error-on-unmatched-pattern',
    ...files,
  ]
  const fmt = spawnSync('pnpm', oxfmtArgs, { stdio })
  if (fmt.status !== 0) {
    return 1
  }
  log(`Running oxlint on ${files.length} file(s)...`)
  const oxlintArgs = ['exec', 'oxlint', '-c', '.config/oxlintrc.json']
  if (fix) {
    oxlintArgs.push('--fix')
  }
  oxlintArgs.push(...files)
  const lint = spawnSync('pnpm', oxlintArgs, { stdio })
  if (lint.status !== 0) {
    return 1
  }
  return 0
}

function main(): void {
  if (mode === 'all') {
    log('Lint scope: all')
    process.exitCode = runAll()
    if (process.exitCode === 0) {
      log('Lint passed')
    } else {
      log('Lint failed')
    }
    return
  }

  const files = mode === 'staged' ? getStagedFiles() : getModifiedFiles()

  if (files.length === 0) {
    log(`No ${mode} files; skipping lint.`)
    return
  }

  if (shouldEscalate(files)) {
    log(`Config files changed; escalating to full lint.`)
    process.exitCode = runAll()
    if (process.exitCode === 0) {
      log('Lint passed')
    } else {
      log('Lint failed')
    }
    return
  }

  const lintable = filterLintable(files)
  log(
    `Lint scope: ${mode} (${lintable.length} of ${files.length} files lintable)`,
  )
  process.exitCode = runFiles(lintable)
  if (process.exitCode === 0) {
    log('Lint passed')
  } else {
    log('Lint failed')
  }
}

main()
