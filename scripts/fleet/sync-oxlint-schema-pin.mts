/**
 * @file Pin every oxlintrc.json `$schema` URL to the SHA of the oxc tag that
 *   matches the INSTALLED oxlint version. A `main`-floating schema URL
 *   validates today's config against tomorrow's schema — rule renames or
 *   option changes upstream flip local validation without any dependency
 *   change. The pin makes schema validation reproducible: same installed
 *   oxlint, same schema bytes.
 *   Usage: node scripts/fleet/sync-oxlint-schema-pin.mts [--check]
 *   --check reports drift and exits non-zero without writing (CI mode).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'
// oxlint-disable-next-line socket/prefer-async-spawn -- single blocking ls-remote gates the whole run; nothing to parallelize.
import { spawnSync } from '@socketsecurity/lib-stable/process/spawn/child'

import { REPO_ROOT } from './paths.mts'

const logger = getDefaultLogger()

const OXC_REPO_URL = 'https://github.com/oxc-project/oxc.git'
const SCHEMA_PATH = 'npm/oxlint/configuration_schema.json'

// Every location an oxlintrc.json may live across fleet layouts (the fleet
// tier, the repo-override tier, and the legacy flat location some members
// still carry).
const OXLINTRC_CANDIDATES = [
  '.config/fleet/oxlintrc.json',
  '.config/oxlintrc.json',
  '.config/repo/oxlintrc.json',
] as const

// Matches a raw.githubusercontent.com oxc schema URL at any ref (branch,
// tag, or SHA) so drift from ANY prior pin style is caught.
const SCHEMA_URL_RE =
  /^https:\/\/raw\.githubusercontent\.com\/oxc-project\/oxc\/[^/]+\/npm\/oxlint\/configuration_schema\.json$/

export function installedOxlintVersion(repoRoot: string): string | undefined {
  const pkgPath = path.join(repoRoot, 'node_modules', 'oxlint', 'package.json')
  if (!existsSync(pkgPath)) {
    return undefined
  }
  try {
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      version?: string
    }
    return parsed.version
  } catch {
    return undefined
  }
}

export function resolveTagSha(version: string): string | undefined {
  const tag = `oxlint_v${version}`
  const result = spawnSync(
    'git',
    ['ls-remote', OXC_REPO_URL, `refs/tags/${tag}`],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) {
    return undefined
  }
  const line = String(result.stdout ?? '').trim()
  const sha = line.split(/\s+/)[0]
  return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : undefined
}

export function expectedSchemaUrl(sha: string): string {
  return `https://raw.githubusercontent.com/oxc-project/oxc/${sha}/${SCHEMA_PATH}`
}

function main(): number {
  const check = process.argv.includes('--check')

  const version = installedOxlintVersion(REPO_ROOT)
  if (!version) {
    logger.fail(
      'oxlint is not installed: node_modules/oxlint/package.json is missing ' +
        `under ${REPO_ROOT}. Wanted the installed version to derive the schema pin. ` +
        'Fix: run `pnpm install`, then re-run this script.',
    )
    return 1
  }

  const sha = resolveTagSha(version)
  if (!sha) {
    logger.fail(
      `Cannot resolve the oxc tag for oxlint ${version}: ` +
        `\`git ls-remote ${OXC_REPO_URL} refs/tags/oxlint_v${version}\` returned no SHA. ` +
        'Saw: no matching tag; wanted: exactly one 40-char SHA. ' +
        'Fix: confirm the tag exists upstream (oxc may still be publishing) and retry.',
    )
    return 1
  }

  const expected = expectedSchemaUrl(sha)
  let drift = 0
  let seen = 0
  for (let i = 0, { length } = OXLINTRC_CANDIDATES; i < length; i += 1) {
    const rel = OXLINTRC_CANDIDATES[i]!
    const abs = path.join(REPO_ROOT, rel)
    if (!existsSync(abs)) {
      continue
    }
    seen += 1
    const raw = readFileSync(abs, 'utf8')
    let parsed: { $schema?: string }
    try {
      parsed = JSON.parse(raw) as { $schema?: string }
    } catch {
      logger.fail(
        `${rel} is not parseable JSON — fix the syntax error before pinning its $schema.`,
      )
      drift += 1
      continue
    }
    const current = parsed.$schema
    if (!current || !SCHEMA_URL_RE.test(current)) {
      // A non-oxc $schema (or none at all) is out of scope for this pin.
      continue
    }
    if (current === expected) {
      continue
    }
    if (check) {
      logger.fail(
        `${rel} $schema drifts from the installed oxlint ${version}: ` +
          `saw ${current}; wanted ${expected} (tag oxlint_v${version}). ` +
          'Fix: run `node scripts/fleet/sync-oxlint-schema-pin.mts`.',
      )
      drift += 1
      continue
    }
    writeFileSync(abs, raw.replace(current, expected), 'utf8')
    logger.success(
      `${rel}: $schema pinned to oxlint_v${version} (${sha.slice(0, 12)})`,
    )
  }

  if (seen === 0) {
    logger.info('No oxlintrc.json found at any known location; nothing to pin.')
    return 0
  }
  if (check && drift > 0) {
    return 1
  }
  if (check) {
    logger.success(`All $schema pins match installed oxlint ${version}.`)
  }
  return 0
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main()
}
