import { readFileSync } from 'node:fs'
import { isMainModule, runMain } from '../cli.mts'

export function validateNpmRelease(
  manifest: { name?: unknown; version?: unknown; private?: unknown },
  config: {
    defaultBranch?: string | undefined
    ref?: string | undefined
    distTag?: string | undefined
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
  if (!config.distTag || !/^[A-Za-z][A-Za-z0-9._-]*$/u.test(config.distTag))
    throw new Error('dist-tag must be a valid npm tag.')
  if (manifest.version === '0.0.0')
    throw new Error('The placeholder package version cannot be staged.')
  const candidate = /-(beta|rc)\.(?:0|[1-9]\d*)$/u.exec(manifest.version)?.[1]
  if (candidate && config.distTag !== candidate && config.distTag !== 'next')
    throw new Error(
      `A ${candidate} candidate requires the ${candidate} or next dist-tag.`,
    )
  if (
    config.distTag === 'latest' &&
    typeof manifest.version === 'string' &&
    manifest.version.includes('-')
  )
    throw new Error('Prerelease versions cannot move the latest dist-tag.')
}

function main(): void {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
    name?: unknown
    version?: unknown
  }
  validateNpmRelease(manifest, {
    defaultBranch: process.env['DEFAULT_BRANCH'],
    ref: process.env['REF'],
    distTag: process.env['DIST_TAG'],
  })
  process.stdout.write(
    `Validated ${String(manifest.name)}@${String(manifest.version)} for ${process.env['DIST_TAG']}.\n`,
  )
}

if (isMainModule(import.meta.url))
  runMain(main, {
    describe: 'Validates the npm release version, tag, and source branch.',
    help: 'Usage: node scripts/repo/npm/validate.mts (inside the publish workflow)',
  })
