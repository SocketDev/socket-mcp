import { readFileSync } from 'node:fs'
import { isMainModule, runMain } from '../cli.mts'
import { matchesReleasePolicy, readReleasePolicy } from './release-policy.mts'
import type { ReleasePolicy } from './release-policy.mts'

export function validateNpmRelease(
  manifest: { name?: unknown; version?: unknown; private?: unknown },
  config: {
    defaultBranch?: string | undefined
    ref?: string | undefined
    distTag?: string | undefined
    policy?: ReleasePolicy | undefined
  },
): void {
  if (
    manifest.private === true ||
    typeof manifest.name !== 'string' ||
    !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(manifest.name)
  )
    throw new Error('package.json must define a public npm package name.')
  if (
    typeof manifest.version !== 'string' ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(
      manifest.version,
    )
  )
    throw new Error('package.json must define a valid release version.')
  if (
    !config.defaultBranch ||
    config.ref !== `refs/heads/${config.defaultBranch}`
  )
    throw new Error(
      'npm publishing must run from the repository default branch.',
    )
  const policy = config.policy ?? readReleasePolicy()
  const distTag = config.distTag ?? policy.distTag
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/u.test(distTag))
    throw new Error('dist-tag must be a valid npm tag.')
  if (distTag !== policy.distTag)
    throw new Error(
      `Release policy requires the ${policy.distTag} dist-tag; received ${distTag}.`,
    )
  if (manifest.version === '0.0.0')
    throw new Error('The placeholder package version cannot be staged.')
  if (!matchesReleasePolicy(manifest.version, policy))
    throw new Error(
      policy.mode === 'prerelease-only'
        ? `Version must stay on the ${policy.versionHint}-${policy.identifier}.N prerelease track.`
        : 'Stable release policy does not allow a prerelease version.',
    )
  if (
    distTag === 'latest' &&
    typeof manifest.version === 'string' &&
    manifest.version.includes('-')
  )
    throw new Error('Prerelease versions cannot move the latest dist-tag.')
}

function main(): void {
  const policy = readReleasePolicy()
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
    name?: unknown
    version?: unknown
  }
  validateNpmRelease(manifest, {
    defaultBranch: process.env['DEFAULT_BRANCH'],
    ref: process.env['REF'],
    distTag: process.env['DIST_TAG'] ?? policy.distTag,
    policy,
  })
  process.stdout.write(
    `Validated ${String(manifest.name)}@${String(manifest.version)} for ${policy.distTag}.\n`,
  )
}

if (isMainModule(import.meta.url))
  runMain(main, {
    describe: 'Validates the npm release version, tag, and source branch.',
    help: 'Usage: node scripts/repo/npm/validate.mts (inside the publish workflow)',
  })
