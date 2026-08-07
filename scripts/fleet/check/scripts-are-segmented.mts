#!/usr/bin/env node
/*
 * @file Enforce the two laws of `scripts/`. Ownership decides placement, and
 *   the two answers have different homes:
 *
 *   1. SEGMENTATION. `scripts/` holds exactly two directories. `fleet/` is
 *      cascade-owned machinery authored in the wheelhouse template, and
 *      `repo/` is this repo's own scripts. A third top-level directory, or a
 *      loose file directly under `scripts/`, sits outside both ownership
 *      tiers: nobody can say whether the cascade owns it, so it drifts.
 *      Underscore-prefixed names (`_shared/`) are the documented internals
 *      escape hatch and pass.
 *   2. THIN PAYLOAD. A fleet MEMBER never tracks anything under
 *      `scripts/fleet/`. That tree arrives from the fleet-pack release at
 *      bootstrap; tracking it duplicates state that then drifts silently, and
 *      answering "is this member behind?" needs a diff instead of a version.
 *      The wheelhouse itself is exempt — it AUTHORS the payload.
 *
 *   The member-side fix for a wrongly-placed file follows ownership: a
 *   repo-owned script moves to `scripts/repo/`; a fleet script is deleted,
 *   because the pack serves it.
 *
 *   Usage: node scripts/fleet/check/scripts-are-segmented.mts [--quiet]
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'
import { normalizePath } from '@socketsecurity/lib-stable/paths/normalize'
import { spawnSync } from '@socketsecurity/lib-stable/process/spawn/child'

import { isMainModule } from '../_shared/is-main-module.mts'
import { REPO_ROOT } from '../paths.mts'
import { collectTrackedFiles } from '../_shared/tracked-globs.mts'
import { runMain } from '../_shared/run-main.mts'

import type { ScriptMeta } from '../_shared/run-main.mts'

const logger = getDefaultLogger()

/**
 * The tree this check owns, repo-relative.
 */
export const SCRIPTS_DIR = 'scripts'

/**
 * The only two ownership tiers `scripts/` may contain.
 */
export const SEGMENT_DIRS: ReadonlySet<string> = new Set(['fleet', 'repo'])

/**
 * The entries under `scripts/` that belong to neither tier, derived from
 * TRACKED paths: a directory that is not `fleet`/`repo`, and any loose file.
 * Dot- and underscore-prefixed names pass, the latter being the documented
 * internals convention.
 *
 * Tracked paths rather than a filesystem walk, because the question is
 * ownership and only a committed file has any. A build output, a scratch dir,
 * or a gitignored cache under `scripts/` belongs to nobody by design, and
 * failing the gate on one would report a violation the repo never made.
 *
 * Pure over the path list, so a test names the shapes instead of building
 * trees.
 */
export function findUnsegmentedEntries(
  trackedPaths: readonly string[],
): string[] {
  const violations = new Set<string>()
  for (let i = 0, { length } = trackedPaths; i < length; i += 1) {
    // Normalized first: a tracked path arrives with whichever separator the
    // platform's git emitted, and every check below is separator-sensitive.
    const rel = normalizePath(trackedPaths[i]!)
    if (!rel.startsWith(`${SCRIPTS_DIR}/`)) {
      continue
    }
    const rest = rel.slice(SCRIPTS_DIR.length + 1)
    const slash = rest.indexOf('/')
    const head = slash === -1 ? rest : rest.slice(0, slash)
    if (head === '' || head.startsWith('.') || head.startsWith('_')) {
      continue
    }
    if (slash !== -1) {
      // A path with a segment below the head names a DIRECTORY.
      if (!SEGMENT_DIRS.has(head)) {
        violations.add(`${head}/`)
      }
      continue
    }
    violations.add(head)
  }
  return [...violations].toSorted()
}

/**
 * Whether this repo AUTHORS the fleet payload rather than consuming it. The
 * wheelhouse tracks `template/base/scripts/fleet/` by definition, and its own
 * live mirror with it; every other repo is a member and must not.
 */
export function isPayloadAuthor(repoRoot: string): boolean {
  return existsSync(path.join(repoRoot, 'template', 'base', 'scripts', 'fleet'))
}

/**
 * Paths tracked under `scripts/fleet/`, or an empty list when the tree is
 * untracked as it should be. Reads git's index rather than the filesystem:
 * the payload is PRESENT on disk in a bootstrapped checkout, so only the
 * index distinguishes a thin repo from a fat one.
 */
export function trackedFleetPaths(repoRoot: string): string[] {
  const result = spawnSync('git', ['ls-files', '--', 'scripts/fleet'], {
    cwd: repoRoot,
    stdioString: true,
  })
  if (result.status !== 0) {
    return []
  }
  return String(result.stdout ?? '')
    .split('\n')
    .filter(line => line !== '')
    .map(line => normalizePath(line))
}

export async function main(): Promise<void> {
  const quiet = process.argv.includes('--quiet')
  const unsegmented = findUnsegmentedEntries(
    await collectTrackedFiles([`${SCRIPTS_DIR}/*`], { cwd: REPO_ROOT }),
  )
  const author = isPayloadAuthor(REPO_ROOT)
  const tracked = author ? [] : trackedFleetPaths(REPO_ROOT)
  if (unsegmented.length === 0 && tracked.length === 0) {
    if (!quiet) {
      logger.success(
        author
          ? 'scripts/ is segmented into fleet/ + repo/ (payload author, fleet tree tracked by design).'
          : 'scripts/ is segmented into fleet/ + repo/, and the fleet payload is untracked.',
      )
    }
    return
  }
  if (unsegmented.length) {
    logger.fail(
      `scripts/ has ${unsegmented.length} unsegmented entr${unsegmented.length === 1 ? 'y' : 'ies'}: ${unsegmented.join(', ')}.`,
    )
    logger.error(
      '  Every script lives under scripts/fleet/ (cascade-owned) or ' +
        'scripts/repo/ (repo-owned) — an entry outside both belongs to ' +
        'nobody and drifts.',
    )
    logger.error(
      '  Fix: `git mv scripts/<name> scripts/repo/<name>` for a repo-owned ' +
        'script, then repoint its references (relative import depth changes). ' +
        'A fleet script is authored in the wheelhouse template and cascaded — ' +
        'delete the local copy instead of moving it.',
    )
  }
  if (tracked.length) {
    logger.fail(
      `scripts/fleet/ has ${tracked.length} TRACKED path(s) — the fleet payload must not be committed.`,
    )
    logger.error(
      '  That tree arrives from the fleet-pack release at bootstrap. Tracking ' +
        'it duplicates state the cascade owns, so the copies drift and ' +
        '"is this member behind?" needs a diff instead of a version.',
    )
    logger.error(
      '  Fix: `git rm -r --cached scripts/fleet` (files stay on disk) and add ' +
        'the payload to .gitignore. FIRST diff the tree against the template: ' +
        'a file that exists only here is repo-owned and moves to ' +
        'scripts/repo/ — untracking it would delete real content.',
    )
  }
  process.exitCode = 1
}

const SCRIPT_META: ScriptMeta = {
  describe:
    'checks that scripts/ is segmented into fleet/ + repo/ and that the fleet payload is untracked',
  help: `Usage: node scripts/fleet/check/scripts-are-segmented.mts [--quiet]

  --quiet   print nothing when the repo is clean`,
}

if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}
