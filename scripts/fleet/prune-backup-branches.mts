#!/usr/bin/env node
/*
 * @file Prune spent backup branches — the rewrite safety nets nothing else
 *   cleans up. `clean.mts` scrubs build output (`target/`, `dist/`); this
 *   scrubs the ref namespace, which grows the same way and is just as invisible
 *   until someone counts.
 *
 *   A ref is deleted only when BOTH gates agree:
 *
 *   1. RETENTION (backup-branches/policy.mts) — outside the newest `--keep N`
 *      AND older than `--days N`. Newest-N covers the fresh net an operator may
 *      still want; the age window stops a rewrite-heavy repo keeping a wall of
 *      same-day nets.
 *   2. SAFETY (backup-branches/unique-content.mts) — the backup holds no file
 *      the default branch is missing. This is a VETO: a ref carrying unique
 *      content is reported loudly and never deleted, whatever its age, because
 *      a rewrite that lost work leaves the backup as the only copy.
 *
 *   Local `backup/<slug>` heads are skipped by default and swept with
 *   `--local`; they are cheap to keep and are often a live worktree's parked
 *   tip. Remote refs are the ones that pile up.
 *
 *   Deleting a remote ref cannot be undone from a clone, so `--dry-run` prints
 *   the full verdict table — prunable, kept-and-why, vetoed-and-why — and the
 *   default `--keep`/`--days` are deliberately generous.
 *
 *   Usage: node scripts/fleet/prune-backup-branches.mts
 *     [--all | --repo owner/name] [--keep N] [--days N] [--local] [--dry-run]
 *   Auth: `gh`/git push access for a remote delete; none for --dry-run.
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { parseArgs } from '@socketsecurity/lib-stable/argv/parse'
import { errorMessage } from '@socketsecurity/lib-stable/errors/message'
import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'

import {
  fleetReposPath,
  parseFleetRepos,
} from './check/member-ci-fires-on-push.mts'
import { REPO_ROOT } from './paths.mts'
import { runCapture } from './publish-infra/shared.mts'
import { isMainModule } from './_shared/is-main-module.mts'
import {
  applyRetention,
  isBackupBranchName,
} from './backup-branches/policy.mts'
import type { BackupRef, RetentionVerdict } from './backup-branches/policy.mts'
import {
  parseUniqueContentPaths,
  uniqueContentDiffArgs,
} from './backup-branches/unique-content.mts'

const logger = getDefaultLogger()

// Remote refs are deleted one at a time. A batched
// `git push --delete a b c` fails the whole batch on one bad ref, so serial
// keeps a single failure from stranding the rest.
const REMOTE = 'origin'
// Vetoed refs can name a long file list; print enough to judge, not a wall.
const MAX_VETO_PATHS_SHOWN = 10

export interface PruneOptions {
  readonly keep?: number | undefined
  readonly days?: number | undefined
  readonly dryRun?: boolean | undefined
  readonly local?: boolean | undefined
  readonly nowMs: number
}

export interface VetoedRef {
  readonly name: string
  readonly onlyOnBackup: readonly string[]
}

export interface PruneOutcome {
  readonly repoDir: string
  readonly deleted: readonly string[]
  readonly kept: readonly RetentionVerdict[]
  // Refs the retention policy would have pruned, held back by the safety gate.
  readonly vetoed: readonly VetoedRef[]
}

/**
 * Resolve the repo's default branch. Never hard-code `main`: a fleet member can
 * be on `master`, and a wrong base would compare the backup against nothing and
 * veto every ref.
 */
export async function resolveDefaultBranch(repoDir: string): Promise<string> {
  const symbolic = await runCapture(
    'git',
    ['symbolic-ref', '--short', `refs/remotes/${REMOTE}/HEAD`],
    repoDir,
  )
  if (symbolic.code === 0) {
    const short = symbolic.stdout.trim().replace(`${REMOTE}/`, '')
    if (short !== '') {
      return short
    }
  }
  for (const candidate of ['main', 'master']) {
    // oxlint-disable-next-line no-await-in-loop -- probing two candidates in order; the second only matters when the first is absent
    const verify = await runCapture(
      'git',
      ['rev-parse', '--verify', `refs/remotes/${REMOTE}/${candidate}`],
      repoDir,
    )
    if (verify.code === 0) {
      return candidate
    }
  }
  throw new Error(
    `cannot resolve the default branch in ${repoDir}: no ${REMOTE}/HEAD and ` +
      `neither ${REMOTE}/main nor ${REMOTE}/master exists. Fix: run ` +
      `\`git remote set-head ${REMOTE} --auto\` in that clone.`,
  )
}

export interface DiscoverOptions {
  readonly local?: boolean | undefined
}

/**
 * Discover backup refs. Remote refs always; local `backup/<slug>` heads only
 * when `local` is set. Names are matched against the anchored patterns so an
 * ordinary branch is never a candidate.
 */
export async function discoverBackupRefs(
  repoDir: string,
  options?: DiscoverOptions | undefined,
): Promise<BackupRef[]> {
  const opts = { __proto__: null, ...options } as DiscoverOptions
  // Two globs per tier: `backup*` alone does not match a slashed
  // `backup/<slug>`, because for-each-ref patterns match whole path segments.
  const globs = [
    `refs/remotes/${REMOTE}/backup*`,
    `refs/remotes/${REMOTE}/backup/*`,
  ]
  if (opts.local === true) {
    globs.push('refs/heads/backup*', 'refs/heads/backup/*')
  }
  const listed = await runCapture(
    'git',
    ['for-each-ref', '--format=%(refname)%09%(committerdate:unix)', ...globs],
    repoDir,
  )
  if (listed.code !== 0) {
    throw new Error(`git for-each-ref failed in ${repoDir}`)
  }
  const refs: BackupRef[] = []
  const listedLines = listed.stdout.split('\n')
  for (let i = 0, { length } = listedLines; i < length; i += 1) {
    const line = listedLines[i]!
    if (line.trim() === '') {
      continue
    }
    const [refname, unix] = line.split('\t')
    if (!refname || !unix) {
      continue
    }
    const name = refname
      .replace(`refs/remotes/${REMOTE}/`, '')
      .replace('refs/heads/', '')
    if (!isBackupBranchName(name)) {
      continue
    }
    refs.push({ committedAtMs: Number(unix) * 1000, name })
  }
  return refs
}

/**
 * Paths present on `branch` and absent from the default branch — empty means
 * the ref is safe to delete.
 */
export async function findUniqueContent(
  repoDir: string,
  branch: string,
  defaultBranch: string,
): Promise<string[]> {
  const diff = await runCapture(
    'git',
    uniqueContentDiffArgs(`${REMOTE}/${branch}`, `${REMOTE}/${defaultBranch}`),
    repoDir,
  )
  if (diff.code !== 0) {
    // The gate fails CLOSED: a ref whose safety cannot be established is
    // reported as unsafe rather than quietly deleted.
    return [`<diff failed for ${branch}; treating as unsafe>`]
  }
  return parseUniqueContentPaths(diff.stdout)
}

export async function pruneRepo(
  repoDir: string,
  config: PruneOptions,
): Promise<PruneOutcome> {
  const cfg = { __proto__: null, ...config } as PruneOptions
  const defaultBranch = await resolveDefaultBranch(repoDir)
  const refs = await discoverBackupRefs(repoDir, { local: cfg.local })
  const verdicts = applyRetention(refs, {
    days: cfg.days,
    keep: cfg.keep,
    nowMs: cfg.nowMs,
  })
  const deleted: string[] = []
  const kept: RetentionVerdict[] = []
  const vetoed: VetoedRef[] = []
  for (const verdict of verdicts) {
    if (!verdict.prunable) {
      kept.push(verdict)
      continue
    }
    const { name } = verdict.ref
    // oxlint-disable-next-line no-await-in-loop -- serial by design: each delete is a remote mutation whose failure must not strand the rest
    const onlyOnBackup = await findUniqueContent(repoDir, name, defaultBranch)
    if (onlyOnBackup.length > 0) {
      vetoed.push({ name, onlyOnBackup })
      continue
    }
    if (cfg.dryRun === true) {
      deleted.push(name)
      continue
    }
    // oxlint-disable-next-line no-await-in-loop -- see above
    const push = await runCapture(
      'git',
      ['push', REMOTE, '--delete', name],
      repoDir,
    )
    if (push.code !== 0) {
      logger.warn(`  failed to delete ${name} (exit ${String(push.code)})`)
      continue
    }
    deleted.push(name)
  }
  return { deleted, kept, repoDir, vetoed }
}

export interface ReportOptions {
  readonly dryRun?: boolean | undefined
}

export function reportOutcome(
  outcome: PruneOutcome,
  options?: ReportOptions | undefined,
): void {
  const opts = { __proto__: null, ...options } as ReportOptions
  const verb = opts.dryRun === true ? 'would delete' : 'deleted'
  logger.info(outcome.repoDir)
  if (outcome.deleted.length > 0) {
    logger.info(`  ${verb} ${String(outcome.deleted.length)}:`)
    for (const name of outcome.deleted) {
      logger.info(`    - ${name}`)
    }
  }
  for (const verdict of outcome.kept) {
    logger.info(`  kept ${verdict.ref.name} — ${verdict.keptBecause ?? ''}`)
  }
  // Loud, never a silent skip: a vetoed ref means a rewrite may have lost work,
  // which is a finding in its own right, not merely a ref that stayed.
  for (const veto of outcome.vetoed) {
    logger.warn(
      `  HELD ${veto.name} — carries ${String(veto.onlyOnBackup.length)} ` +
        `file(s) the default branch lacks; a rewrite may have lost work:`,
    )
    const shown = veto.onlyOnBackup.slice(0, MAX_VETO_PATHS_SHOWN)
    for (let i = 0, { length } = shown; i < length; i += 1) {
      logger.warn(`      ${shown[i]!}`)
    }
  }
  if (
    outcome.deleted.length === 0 &&
    outcome.kept.length === 0 &&
    outcome.vetoed.length === 0
  ) {
    logger.info('  no backup branches')
  }
}

export interface TargetOptions {
  readonly all?: boolean | undefined
}

export function resolveTargetDirs(
  repoRoot: string,
  options?: TargetOptions | undefined,
): string[] {
  const opts = { __proto__: null, ...options } as TargetOptions
  if (opts.all !== true) {
    return [repoRoot]
  }
  const rosterPath = fleetReposPath(repoRoot)
  if (!existsSync(rosterPath)) {
    throw new Error(
      `--all needs the cascaded fleet roster. Where: ${rosterPath}. ` +
        `Saw: missing. Fix: cascade this repo, or drop --all.`,
    )
  }
  const repos = parseFleetRepos(readFileSync(rosterPath, 'utf8'))
  const siblings = path.dirname(repoRoot)
  const dirs: string[] = []
  for (const repo of repos) {
    dirs.push(path.join(siblings, repo.name))
  }
  return dirs
}

export async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      all: { type: 'boolean' },
      days: { type: 'string' },
      'dry-run': { type: 'boolean' },
      keep: { type: 'string' },
      local: { type: 'boolean' },
      repo: { type: 'string' },
    },
    strict: true,
  })
  const dryRun = values['dry-run'] === true
  const options: PruneOptions = {
    days: values['days'] === undefined ? undefined : Number(values['days']),
    dryRun,
    keep: values['keep'] === undefined ? undefined : Number(values['keep']),
    local: values['local'] === true,
    // Injected rather than read inside the policy so the retention rules stay
    // deterministic under test.
    nowMs: Date.now(),
  }
  const repoFlag = values['repo']
  const targets =
    typeof repoFlag === 'string'
      ? [path.join(path.dirname(REPO_ROOT), repoFlag.split('/').pop() ?? '')]
      : resolveTargetDirs(REPO_ROOT, { all: values['all'] === true })
  let vetoTotal = 0
  for (const dir of targets) {
    if (!existsSync(dir)) {
      continue
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- serial across repos: each prune mutates a remote and reports before the next starts
      const outcome = await pruneRepo(dir, options)
      reportOutcome(outcome, { dryRun })
      vetoTotal += outcome.vetoed.length
    } catch (e) {
      logger.error(`${dir}: ${errorMessage(e)}`)
      process.exitCode = 1
    }
  }
  if (vetoTotal > 0) {
    logger.warn(
      `\n${String(vetoTotal)} backup branch(es) held back — each carries a ` +
        `file its default branch lacks. Review before deleting by hand.`,
    )
  }
}

if (isMainModule(import.meta.url)) {
  // Async IIFE, not top-level await: the CJS bundle target cannot carry TLA.
  void (async () => {
    await main()
  })()
}
