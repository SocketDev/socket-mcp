/*
 * Squashing-history runner — the pre-flight guards that decide whether a
 * squash may proceed at all, before any worktree or history rewrite starts.
 * Each guard returns `undefined` to let main() continue, or the process exit
 * code main() should return immediately.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { errorMessage } from '@socketsecurity/lib/errors/message'
import { getDefaultLogger } from '@socketsecurity/lib/logger/default'

import {
  isOptedIn,
  loadRosterFromRepo,
} from '../../../hooks/fleet/_shared/fleet-roster.mts'
import { run } from '../_shared/scripts/run-helpers.mts'
import {
  crateNamesFromCargoManifest,
  npmPackageNameFromManifest,
} from '../../../../scripts/fleet/_shared/member-release-probe.mts'
import { resolveCrateReleaseSha } from '../../../../scripts/fleet/crate-release-sha.mts'
import { fetchLatestGitHead } from '../../../../scripts/fleet/publish-infra/npm/registry.mts'
import {
  publishedReleaseBlocksSquash,
  resolveFreezeBoundary,
} from '../../../../scripts/fleet/lib/squash-publish-guard.mts'

import type {
  FreezeAncestryInfo,
  FreezeAnchorCandidate,
} from '../../../../scripts/fleet/lib/squash-publish-guard.mts'

const logger = getDefaultLogger()

// A workspace directory (`packages/*`, `crates/*`) contributes at most this
// many manifests to the freeze-boundary probe. A registry-scale monorepo has
// hundreds of directories; past the cap the probe stops widening rather than
// issuing hundreds of registry reads for one squash run.
const MAX_WORKSPACE_ENTRIES = 25

/**
 * Code-is-law opt-in gate. Squash is destructive history rewrite, so the
 * ROSTER decides which repos it may touch — not a path arg a human, or a
 * fuzzy name-match, points at. A non-fleet repo, no roster, or absent from
 * it, is refused outright: this is the guard that stops a `cdxgen` from being
 * squashed because it resembles `sdxgen`.
 *
 * The published-release safeguard is a SEPARATE step
 * (`resolveFreezeBoundaryForRepo`) — a real release no longer refuses the
 * squash outright, it sets the freeze boundary the squash collapses ABOVE.
 */
export async function checkSquashAllowed(config: {
  readonly fleetName: string
  readonly src: string
}): Promise<number | undefined> {
  const cfg = { __proto__: null, ...config } as {
    fleetName: string
    src: string
  }
  const { fleetName, src } = cfg

  const roster = loadRosterFromRepo(src)
  if (!roster) {
    logger.error(
      `error: ${src} carries no fleet roster (cascading-fleet/lib/` +
        `fleet-repos.json) — it is not a fleet repo, so squash is refused. ` +
        `Squash only opted-in fleet members.`,
    )
    return 2
  }
  if (!isOptedIn(roster, fleetName, 'squash-history')) {
    logger.error(
      `error: ${fleetName} is not opted into 'squash-history' in the fleet ` +
        `roster — refusing to rewrite its history. ` +
        `Saw: no 'squash-history' in its optIns; wanted the opt-in. ` +
        `Fix: add "${fleetName}" with optIns:['squash-history'] to ` +
        `cascading-fleet/lib/fleet-repos.json (then cascade), or squash a ` +
        `repo that is already opted in.`,
    )
    return 2
  }
  return undefined
}

// Every manifest TEXT for one packaging surface, read from the LOCAL
// checkout: the root manifest, then one workspace directory down
// (`packages/*` for npm, `crates/*` for cargo) — the local mirror of
// `member-release-probe.mts`'s remote (GH API) surface reader, since this
// guard runs against a checkout on disk, not another repo over the network.
function localManifestTexts(
  src: string,
  rootName: string,
  workspaceDir: string,
): string[] {
  const texts: string[] = []
  const rootPath = path.join(src, rootName)
  if (existsSync(rootPath)) {
    texts.push(readFileSync(rootPath, 'utf8'))
  }
  const dir = path.join(src, workspaceDir)
  if (!existsSync(dir)) {
    return texts
  }
  let entries: string[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
  } catch {
    entries = []
  }
  for (
    let i = 0, { length } = entries;
    i < length && i < MAX_WORKSPACE_ENTRIES;
    i += 1
  ) {
    const manifestPath = path.join(dir, entries[i]!, rootName)
    if (existsSync(manifestPath)) {
      texts.push(readFileSync(manifestPath, 'utf8'))
    }
  }
  return texts
}

// Every freeze-anchor candidate this checkout's manifests declare, plus
// whether ANY of them is a REAL published release. One network read per
// declared npm package / crate — fail-open per read: a lookup failure
// contributes no candidate rather than blocking the resolution (matching the
// registry-read fail-open contract every other squash-allowed check here
// carries).
async function collectFreezeAnchors(src: string): Promise<{
  candidates: FreezeAnchorCandidate[]
  published: boolean
}> {
  const candidates: FreezeAnchorCandidate[] = []
  let published = false

  const npmTexts = localManifestTexts(src, 'package.json', 'packages')
  for (let i = 0, { length } = npmTexts; i < length; i += 1) {
    const name = npmPackageNameFromManifest(npmTexts[i]!)
    if (name === undefined) {
      continue
    }
    let read: Awaited<ReturnType<typeof fetchLatestGitHead>>
    try {
      read = await fetchLatestGitHead(name)
    } catch {
      continue
    }
    if (!read.reachable || !read.version) {
      continue
    }
    if (!publishedReleaseBlocksSquash('npm', read.version)) {
      continue
    }
    published = true
    candidates.push({
      sha: read.sha,
      source: `npm:${name}@${read.version}`,
    })
  }

  const cargoTexts = localManifestTexts(src, 'Cargo.toml', 'crates')
  for (let i = 0, { length } = cargoTexts; i < length; i += 1) {
    const names = crateNamesFromCargoManifest(cargoTexts[i]!)
    for (let j = 0, count = names.length; j < count; j += 1) {
      let info: Awaited<ReturnType<typeof resolveCrateReleaseSha>>
      try {
        info = await resolveCrateReleaseSha(names[j]!)
      } catch {
        continue
      }
      if (!info || !publishedReleaseBlocksSquash('cargo', info.version)) {
        continue
      }
      published = true
      candidates.push({
        sha: info.sha,
        source: `crate:${names[j]!}@${info.version}`,
      })
    }
  }

  return { candidates, published }
}

/**
 * Ancestry for a set of candidate SHAs against `tip` — the branch commit
 * about to be squashed — via `git merge-base --is-ancestor` plus `git
 * rev-list --count <sha>..<tip>` (only computed when the ancestor check
 * holds; ranking a rejected candidate is pointless).
 */
async function computeHeadAncestry(
  src: string,
  tip: string,
  shas: readonly string[],
): Promise<Map<string, FreezeAncestryInfo>> {
  const map = new Map<string, FreezeAncestryInfo>()
  for (let i = 0, { length } = shas; i < length; i += 1) {
    const sha = shas[i]!
    if (map.has(sha)) {
      continue
    }
    const isAncestor =
      (
        await run('git', ['merge-base', '--is-ancestor', sha, tip], src, {
          allowFailure: true,
        })
      ).code === 0
    let distance = Number.POSITIVE_INFINITY
    if (isAncestor) {
      distance = Number(
        (await run('git', ['rev-list', '--count', `${sha}..${tip}`], src))
          .stdout || '0',
      )
    }
    map.set(sha, { distance, isAncestor })
  }
  return map
}

export interface FreezeBoundaryResolution {
  /**
   * The newest ancestor-verified published-release SHA to freeze at, or
   * `undefined` when a full-root squash is safe (nothing published).
   */
  readonly boundary?: string | undefined
  /**
   * Set when the repo has a confirmed published release with no safe anchor
   * to freeze at — the caller must refuse the squash (exit 2) rather than
   * proceed with `boundary: undefined`, which would read as "safe to
   * full-flatten".
   */
  readonly refuseMessage?: string | undefined
}

/**
 * Resolve this checkout's squash-freeze boundary against `tip` (the branch
 * commit about to be squashed): discover every npm package / crate this repo
 * (root + one workspace level) declares, probe each on its registry for a
 * REAL published release and that release's recorded source commit, verify
 * ancestry, and hand the whole set to the pure `resolveFreezeBoundary`.
 *
 * `resolveFreezeBoundary`'s thrown "unresolvable anchor" case is caught here
 * and turned into a `refuseMessage` — main() logs it and returns exit 2,
 * never silently treating it as `boundary: undefined` (full-root safe).
 */
export async function resolveFreezeBoundaryForRepo(config: {
  readonly src: string
  readonly tip: string
}): Promise<FreezeBoundaryResolution> {
  const cfg = { __proto__: null, ...config } as { src: string; tip: string }
  const { src, tip } = cfg

  const { candidates, published } = await collectFreezeAnchors(src)
  const shas = candidates
    .map(c => c.sha)
    .filter((sha): sha is string => sha !== undefined)
  const headAncestry = await computeHeadAncestry(src, tip, shas)

  try {
    return {
      boundary: resolveFreezeBoundary({ candidates, headAncestry, published }),
    }
  } catch (e) {
    return {
      refuseMessage: errorMessage(e),
    }
  }
}

/**
 * A shallow clone's commit graph is grafted, so `rev-list --count` reports
 * the fetch depth, not the branch's true history — a depth-1 clone always
 * reads as "already squashed" and the single-commit early-exit silently
 * no-ops on a full-history remote. Refuse loudly; unshallow first (or squash
 * via a tree snapshot, which needs no history).
 */
export async function checkNotShallowClone(config: {
  readonly base: string
  readonly src: string
}): Promise<number | undefined> {
  const cfg = { __proto__: null, ...config } as { base: string; src: string }
  const { base, src } = cfg

  const shallow = (
    await run('git', ['rev-parse', '--is-shallow-repository'], src)
  ).stdout
  if (shallow === 'true') {
    logger.error(
      `error: ${src} is a SHALLOW clone — its local graph cannot answer ` +
        `"how many commits does origin/${base} have". ` +
        `Saw a grafted history; wanted the full graph. ` +
        `Fix: git -C ${src} fetch --unshallow origin ${base}, then re-run.`,
    )
    return 2
  }
  return undefined
}
