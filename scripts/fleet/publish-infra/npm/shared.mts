/**
 * @file Npm-specific shared helpers for the npm-publish modes: the
 *   staged-entry shape, package.json + staged-shasum readers, the
 *   `pnpm stage list` fetch, prior-provenance lookup, and the
 *   staging-expected trust check consumed by both --staged and --direct.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { extractFirstJson, rootPath, runCapture } from '../shared.mts'
import { fetchVersionTrustInfo } from './registry.mts'

export interface StageListEntry {
  name?: string | undefined
  version?: string | undefined
  stageId?: string | undefined
  // sha1 hex npm recorded for the staged tarball. `pnpm stage list --json` is
  // the ONLY pre-approve source of the server-side digest — a staged version is
  // not in the public packument, so fetchVersionTrustInfo can't see it. The
  // field name is unverified without a live staged run; readStagedShasum probes
  // the known shapes and the gate fails LOUD (never silently skips) when none
  // resolve.
  shasum?: string | undefined
}

export function readPackageJson(): { name: string; version: string } {
  const raw = readFileSync(path.join(rootPath, 'package.json'), 'utf8')
  return JSON.parse(raw) as { name: string; version: string }
}

/**
 * Extract the staged tarball's sha1 from a `pnpm stage list --json` entry. The
 * field name is UNVERIFIED without a live staged run — probe the plausible
 * shapes (top-level `shasum`, then `dist.shasum`). Returns undefined when none
 * resolve; the pre-approve gate then fails LOUD (never silently skips) so a
 * field-name drift surfaces as a hard stop, not a false-green. (`integrity` is
 * sha512 — a different axis — so it is not reduced to sha1 here.)
 */
export function readStagedShasum(entry: {
  dist?: { shasum?: unknown | undefined } | undefined
  shasum?: unknown | undefined
}): string | undefined {
  if (typeof entry.shasum === 'string' && entry.shasum) {
    return entry.shasum
  }
  if (typeof entry.dist?.shasum === 'string' && entry.dist.shasum) {
    return entry.dist.shasum
  }
  return undefined
}

/**
 * Resolve all currently-staged packages by parsing `pnpm stage list --json`.
 * The output's first balanced JSON object is the keyed map `<name>@<version>` →
 * entry; we flatten the values and drop entries without a stageId (defensive).
 */
export async function listStagedPackages(): Promise<StageListEntry[]> {
  const { stdout } = await runCapture(
    'pnpm',
    ['stage', 'list', '--json'],
    rootPath,
  )
  const json = extractFirstJson(stdout)
  if (!json) {
    return []
  }
  try {
    const parsed = JSON.parse(json) as Record<
      string,
      StageListEntry | undefined
    >
    const result: StageListEntry[] = []
    for (const entry of Object.values(parsed)) {
      if (entry?.stageId) {
        result.push({ ...entry, shasum: readStagedShasum(entry) })
      }
    }
    return result
  } catch {
    return []
  }
}

/**
 * For each unique package name in `entries`, fetch the latest version's trust
 * info from the registry. Used to annotate the approve multi- select with a
 * "this package's last public version had provenance" hint — helps the approver
 * spot if their staged upload is a regression (parent name has provenance
 * history; staged version's workflow may have lost OIDC).
 *
 * One registry GET per unique name; abbreviated packument (saves ~80KB per
 * popular package, omits `_npmUser` which we don't need here).
 */
export async function fetchPriorProvenanceMap(
  entries: StageListEntry[],
): Promise<Map<string, boolean>> {
  const uniqueNames = new Set<string>()
  for (let i = 0, { length } = entries; i < length; i += 1) {
    const e = entries[i]!
    if (e.name) {
      uniqueNames.add(e.name)
    }
  }
  const result = new Map<string, boolean>()
  await Promise.all(
    [...uniqueNames].map(async name => {
      const versions = await fetchVersionTrustInfo(name, 'abbreviated')
      const hasAnyAttestation = Object.values(versions).some(
        v => !!v.attestations,
      )
      result.set(name, hasAnyAttestation)
    }),
  )
  return result
}

export function formatPriorProvenance(
  hasPriorProvenance: boolean | undefined,
): string {
  if (hasPriorProvenance === undefined) {
    return ''
  }
  return hasPriorProvenance
    ? '  [prior: ✓ provenance]'
    : '  [prior: ✗ no provenance]'
}

/**
 * Detect whether this package has previously been published via the staged
 * path. Returns true when ANY published version of `pkg.name` carries the
 * registry packument's `_npmUser.approver` field — the signal pnpm uses for its
 * `stagedPublish` trust-evidence tier (see github.com/pnpm/pnpm pull 12056). A
 * package with an approver in its history has chosen the strongest trust path
 * available; downgrading to --direct for a new version would erase that signal
 * in the package's trust chain.
 *
 * Used by --direct to refuse running when the package's prior versions used
 * staging: we want that trade-off to be a deliberate choice, not an accident.
 * First-publish packages (no prior versions) get a pass — they have no staged
 * history to preserve.
 */
export async function isStagingExpected(pkgName: string): Promise<boolean> {
  try {
    const versions = await fetchVersionTrustInfo(pkgName, 'full')
    for (const v of Object.values(versions)) {
      if (v.approver !== undefined) {
        return true
      }
    }
  } catch {
    // Network failure / 404 / unparseable packument — treat as
    // "unknown" and don't block the --direct path on it.
  }
  return false
}
