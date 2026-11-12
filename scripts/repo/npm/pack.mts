import { execFileSync } from 'node:child_process'
import path from 'node:path'

export interface NpmPayloadManifest {
  name: string
  version: string
  main?: string
  bin?: string | Record<string, string>
  files?: string[]
}

export function validateNpmPayload(
  manifest: NpmPayloadManifest,
  packed: unknown,
  entries: string[],
): void {
  const identity = packed as Partial<NpmPayloadManifest> | null
  if (
    identity?.name !== manifest.name ||
    identity.version !== manifest.version
  ) {
    throw new Error('Packed package identity does not match package.json.')
  }
  const required = [
    'package.json',
    ...(manifest.main ? [manifest.main] : []),
    ...(typeof manifest.bin === 'string'
      ? [manifest.bin]
      : Object.values(manifest.bin ?? {})),
    ...(manifest.files ?? []).filter(entry => !entry.startsWith('!')),
  ]
  const payload = entries.map(entry =>
    entry.replaceAll('\\', '/').replace(/^package\//u, ''),
  )
  for (const entry of required) {
    const relative = entry.replace(/^\.\//u, '').replace(/\/$/u, '')
    if (
      !payload.some(
        file =>
          file === relative ||
          file.startsWith(`${relative}/`) ||
          path.posix.matchesGlob(file, relative),
      )
    ) {
      throw new Error(
        `Packed package is missing required payload: ${relative}.`,
      )
    }
  }
}

export function verifyNpmTarball(
  tarball: string,
  manifest: NpmPayloadManifest,
): void {
  const options = {
    encoding: 'utf8' as const,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
  }
  const entries = execFileSync('tar', ['-tzf', tarball], options)
    .trim()
    .split(/\r?\n/u)
  const packed: unknown = JSON.parse(
    execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], options),
  )
  validateNpmPayload(manifest, packed, entries)
}
