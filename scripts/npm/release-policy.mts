import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export type ReleasePolicy =
  | { mode: 'stable-from-hint'; distTag: string }
  | {
      mode: 'prerelease-only'
      versionHint: string
      identifier: string
      distTag: string
    }

const STABLE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u
const DIST_TAG = /^[A-Za-z][A-Za-z0-9._-]*$/u

export function parseReleasePolicy(value: unknown): ReleasePolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Release policy must be an object.')
  const policy = value as Record<string, unknown>
  if (
    typeof policy['distTag'] !== 'string' ||
    !DIST_TAG.test(policy['distTag'])
  )
    throw new Error('Release policy must define a valid distTag.')
  if (policy['mode'] === 'stable-from-hint')
    return { mode: 'stable-from-hint', distTag: policy['distTag'] }
  if (
    policy['mode'] === 'prerelease-only' &&
    typeof policy['versionHint'] === 'string' &&
    STABLE_VERSION.test(policy['versionHint']) &&
    typeof policy['identifier'] === 'string' &&
    /^[A-Za-z0-9-]+$/u.test(policy['identifier'])
  ) {
    const expectedDistTag = `prerelease-${policy['versionHint']}`
    if (policy['distTag'] !== expectedDistTag)
      throw new Error(
        `Prerelease-only release policy must use the ${expectedDistTag} dist-tag.`,
      )
    return {
      mode: 'prerelease-only',
      versionHint: policy['versionHint'],
      identifier: policy['identifier'],
      distTag: policy['distTag'],
    }
  }
  throw new Error(
    'Release policy mode must be stable-from-hint or prerelease-only with a stable versionHint and identifier.',
  )
}

export function releasePolicyPath(root = process.cwd()): string {
  const candidates = [
    path.join(root, '.config/release.json'),
    path.join(root, 'release.json'),
    path.join(root, '.release.json'),
  ]
  const found = candidates.filter(existsSync)
  if (found.length > 1)
    throw new Error(
      `Found multiple release configurations: ${found.map(filename => path.relative(root, filename)).join(', ')}. Keep only .config/release.json.`,
    )
  if (found.length === 0)
    throw new Error(
      `Release configuration not found. Looked for ${candidates.map(filename => path.relative(root, filename)).join(', ')}.`,
    )
  return found[0]!
}

export function readReleasePolicy(root = process.cwd()): ReleasePolicy {
  return parseReleasePolicy(
    JSON.parse(readFileSync(releasePolicyPath(root), 'utf8')) as unknown,
  )
}

export function matchesReleasePolicy(
  version: string,
  policy: ReleasePolicy,
): boolean {
  if (policy.mode === 'stable-from-hint') return STABLE_VERSION.test(version)
  return (
    version.startsWith(`${policy.versionHint}-${policy.identifier}.`) &&
    /^(?:0|[1-9]\d*)$/u.test(
      version.slice(`${policy.versionHint}-${policy.identifier}.`.length),
    )
  )
}
