/*
 * @file git worktree janitor, the sibling of rust-target-sweep. A worktree
 *   outlives the work that created it: the branch lands, the checkout stays,
 *   and the next `git worktree list` is a wall of `/private/tmp/wh-*` entries
 *   nobody can classify at a glance. Unlike a target/ dir, a worktree can hold
 *   the only copy of something, so this sweeper's bar for removal is much
 *   higher than staleness.
 *
 *   REMOVABLE means all three, never fewer:
 *     1. Clean — no uncommitted change, staged or not.
 *     2. Merged — HEAD is an ancestor of the default branch, so every commit
 *        is already in main.
 *     3. Not the primary checkout, and not locked.
 *
 *   Anything failing one of those is REPORTED, never removed, with the reason
 *   named. A dirty worktree and an unmerged branch are the two shapes that
 *   hold unique work, and "the branch looked old" is not evidence the work
 *   inside it was finished — that is exactly the reasoning that loses a
 *   session's only copy of something.
 *
 *   Staleness is a FILTER, not a licence. `--stale-days` narrows which
 *   removable worktrees are swept and defaults to 0, meaning no age
 *   requirement. It never promotes an unmerged or dirty worktree into being
 *   removable.
 *
 *   Dry-run by default; `--fix` removes. Stale administrative entries are
 *   pruned either way. Note: those are worktrees whose directory a human
 *   already deleted, so pruning them reclaims nothing and loses nothing.
 *
 *   Usage: node scripts/fleet/worktree-sweep.mts [--stale-days N] [--fix]
 */
import path from 'node:path'

import { parseArgs } from '@socketsecurity/lib-stable/argv/parse'
import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'
import { normalizePath } from '@socketsecurity/lib-stable/paths/normalize'
import { spawn } from '@socketsecurity/lib-stable/process/spawn/child'

import { REPO_ROOT } from './paths.mts'
import { isMainModule } from './_shared/is-main-module.mts'
import { runMain } from './_shared/run-main.mts'

import type { ScriptMeta } from './_shared/run-main.mts'

const logger = getDefaultLogger()

const MS_PER_DAY = 86_400_000

/**
 * One worktree as `git worktree list --porcelain` describes it.
 */
export interface WorktreeEntry {
  readonly branch?: string | undefined
  readonly head?: string | undefined
  readonly locked: boolean
  readonly path: string
  readonly prunable: boolean
}

/**
 * Why a worktree may not be swept, or undefined when it may.
 */
export type KeepReason =
  | 'dirty'
  | 'locked'
  | 'primary'
  | 'too-fresh'
  | 'unmerged'

/**
 * One worktree's verdict.
 */
export interface WorktreeVerdict {
  readonly entry: WorktreeEntry
  readonly keep?: KeepReason | undefined
}

/**
 * Parse `git worktree list --porcelain` into entries. The format is
 * blank-line-separated records of `key value` lines, with bare `bare`,
 * `detached`, `locked`, and `prunable` flags. Pure; exported for tests.
 */
export function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = []
  const blocks = stdout.split(/\r?\n\r?\n/)
  for (let i = 0, { length } = blocks; i < length; i += 1) {
    const lines = blocks[i]!.split(/\r?\n/)
    let entryPath = ''
    let head
    let branch
    let locked = false
    let prunable = false
    for (let j = 0, lineCount = lines.length; j < lineCount; j += 1) {
      const line = lines[j]!
      if (line.startsWith('worktree ')) {
        entryPath = line.slice('worktree '.length)
      } else if (line.startsWith('HEAD ')) {
        head = line.slice('HEAD '.length)
      } else if (line.startsWith('branch ')) {
        branch = line.slice('branch '.length).replace(/^refs\/heads\//u, '')
      } else if (line === 'locked' || line.startsWith('locked ')) {
        locked = true
      } else if (line === 'prunable' || line.startsWith('prunable ')) {
        prunable = true
      }
    }
    if (entryPath) {
      out.push({ branch, head, locked, path: entryPath, prunable })
    }
  }
  return out
}

/**
 * The keep-reason for one worktree, or undefined when it is removable. Pure —
 * every fact is passed in, so the decision is testable without a repo.
 */
export function verdictFor(config: {
  ageMs: number
  entry: WorktreeEntry
  isDirty: boolean
  isMerged: boolean
  isPrimary: boolean
  staleDays: number
}): WorktreeVerdict {
  const { ageMs, entry, isDirty, isMerged, isPrimary, staleDays } = {
    __proto__: null,
    ...config,
  } as typeof config
  // Order matters only for which reason is reported first; each is
  // independently disqualifying.
  if (isPrimary) {
    return { entry, keep: 'primary' }
  }
  if (entry.locked) {
    return { entry, keep: 'locked' }
  }
  if (isDirty) {
    return { entry, keep: 'dirty' }
  }
  if (!isMerged) {
    return { entry, keep: 'unmerged' }
  }
  if (staleDays > 0 && ageMs < staleDays * MS_PER_DAY) {
    return { entry, keep: 'too-fresh' }
  }
  return { entry }
}

/**
 * The human-readable reason a kept worktree was kept.
 */
export function describeKeep(reason: KeepReason): string {
  switch (reason) {
    case 'dirty':
      return 'has uncommitted changes — the only copy may live here'
    case 'locked':
      return 'locked; unlock it first if it is really finished'
    case 'primary':
      return 'the primary checkout'
    case 'too-fresh':
      return 'newer than --stale-days'
    default:
      return 'branch is NOT merged into the default branch'
  }
}

async function git(
  args: readonly string[],
  cwd: string,
): Promise<{ code: number; stderr: string; stdout: string }> {
  try {
    const result = await spawn('git', [...args], { cwd })
    return {
      code: result.code ?? 0,
      stderr: String(result.stderr ?? ''),
      stdout: String(result.stdout ?? ''),
    }
  } catch (e) {
    const err = e as { stderr?: unknown | undefined }
    return { code: 1, stderr: String(err?.stderr ?? ''), stdout: '' }
  }
}

/**
 * True when git refused a worktree removal because the tree contains
 * submodules, which it reports as `fatal: working trees containing submodules
 * cannot be moved or removed`. Pure; exported for tests.
 *
 * That refusal is a git limitation, not evidence of unique work. The tree has
 * already passed clean-AND-merged, and a submodule's content is reproducible
 * from its pinned ref, so deiniting and retrying loses nothing.
 */
export function isSubmoduleRefusal(stderr: string): boolean {
  return /working trees containing submodules cannot be/iu.test(stderr)
}

/**
 * The default branch ref, resolved rather than hardcoded: `main` and `master`
 * both exist across the fleet's upstreams.
 */
export async function resolveDefaultBranch(repoRoot: string): Promise<string> {
  const symbolic = await git(
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    repoRoot,
  )
  const name = symbolic.stdout.trim().replace(/^origin\//u, '')
  if (name) {
    return `origin/${name}`
  }
  const hasMain = await git(
    ['rev-parse', '--verify', '--quiet', 'origin/main'],
    repoRoot,
  )
  return hasMain.code === 0 ? 'origin/main' : 'origin/master'
}

export async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      fix: { default: false, type: 'boolean' },
      'stale-days': { default: '0', type: 'string' },
    },
    strict: false,
  })
  const fix = values['fix'] === true
  const staleDays =
    Number.parseInt(String(values['stale-days'] ?? '0'), 10) || 0

  const listed = await git(['worktree', 'list', '--porcelain'], REPO_ROOT)
  const entries = parseWorktreeList(listed.stdout)
  if (entries.length <= 1) {
    logger.success(
      '[worktree-sweep] no secondary worktrees — nothing to sweep.',
    )
    return 0
  }

  const defaultBranch = await resolveDefaultBranch(REPO_ROOT)
  const primary = normalizePath(REPO_ROOT)
  const now = Date.now()
  const verdicts: WorktreeVerdict[] = []
  for (let i = 0, { length } = entries; i < length; i += 1) {
    const entry = entries[i]!
    const isPrimary = normalizePath(entry.path) === primary
    // A prunable entry's directory is already gone; `git worktree prune`
    // handles it and nothing can be lost, so it never needs the full read.
    if (!isPrimary && !entry.prunable) {
      const status = await git(['status', '--porcelain'], entry.path)
      const merged = await git(
        ['merge-base', '--is-ancestor', 'HEAD', defaultBranch],
        entry.path,
      )
      const log = await git(['log', '-1', '--format=%ct'], entry.path)
      const committedAt = Number.parseInt(log.stdout.trim(), 10)
      verdicts.push(
        verdictFor({
          ageMs: Number.isFinite(committedAt)
            ? now - committedAt * 1000
            : Number.POSITIVE_INFINITY,
          entry,
          isDirty: status.stdout.trim() !== '',
          isMerged: merged.code === 0,
          isPrimary: false,
          staleDays,
        }),
      )
      continue
    }
    verdicts.push(
      verdictFor({
        ageMs: Number.POSITIVE_INFINITY,
        entry,
        isDirty: false,
        isMerged: true,
        isPrimary,
        staleDays,
      }),
    )
  }

  const removable = verdicts.filter(v => !v.keep && !v.entry.prunable)
  const kept = verdicts.filter(v => v.keep && v.keep !== 'primary')
  const prunable = verdicts.filter(v => v.entry.prunable)

  for (let i = 0, { length } = kept; i < length; i += 1) {
    const v = kept[i]!
    logger.warn(
      `  keep    ${path.basename(v.entry.path)} (${v.entry.branch ?? 'detached'}) — ${describeKeep(v.keep!)}`,
    )
  }
  for (let i = 0, { length } = removable; i < length; i += 1) {
    const v = removable[i]!
    logger.log(
      `  ${fix ? 'remove ' : 'would  '} ${path.basename(v.entry.path)} (${v.entry.branch ?? 'detached'}) — clean and merged`,
    )
  }

  if (fix) {
    for (let i = 0, { length } = removable; i < length; i += 1) {
      const v = removable[i]!
      let removed = await git(['worktree', 'remove', v.entry.path], REPO_ROOT)
      // Submodules are the one refusal worth retrying through, and ONLY with
      // --force. `git submodule deinit --all --force` looks like the polite
      // fix and is not one: it exits 0, leaves `git submodule status` empty,
      // and git still refuses, because the check is on the HEAD tree's
      // submodule entries rather than on whether any are initialized.
      //
      // Reaching for --force is safe HERE and nowhere else in this script: the
      // tree already passed clean-AND-merged, so what --force overrides is a
      // git limitation, not a warning about unique work.
      if (removed.code !== 0 && isSubmoduleRefusal(removed.stderr)) {
        removed = await git(
          ['worktree', 'remove', '--force', v.entry.path],
          REPO_ROOT,
        )
      }
      if (removed.code !== 0) {
        logger.warn(
          `  kept    ${path.basename(v.entry.path)} — git refused the remove (${removed.stderr.trim().split('\n')[0] ?? 'no reason given'}); left in place.`,
        )
      }
    }
    if (prunable.length) {
      await git(['worktree', 'prune'], REPO_ROOT)
    }
  }

  logger.success(
    `[worktree-sweep] ${removable.length} removable, ${kept.length} kept, ${prunable.length} prunable${fix ? '' : ' — dry run, pass --fix to sweep'}.`,
  )
  return 0
}

const SCRIPT_META: ScriptMeta = {
  describe: 'remove git worktrees that are clean AND merged; report the rest',
  help: `Usage: node scripts/fleet/worktree-sweep.mts [flags]
  --stale-days N  only sweep worktrees whose last commit is older than N days
                  (default 0 — no age requirement). Narrows what is swept; it
                  never makes a dirty or unmerged worktree removable.
  --fix           actually remove. Default is a dry run.

A worktree is removed ONLY when it is clean, merged into the default branch,
unlocked, and not the primary checkout. Everything else is reported with the
reason, because a dirty tree or an unmerged branch can hold the only copy of
something.`,
}

/* c8 ignore start - entry-point wiring, exercised by running the script. */
if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}
/* c8 ignore stop */
