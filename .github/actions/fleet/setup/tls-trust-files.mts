/**
 * @file Dependency-free bounded public CA file reads for the setup action.
 */
import crypto from 'node:crypto'
import { filterTlsCertificates } from '../../../../scripts/fleet/process/tls-policy.mts'
import { readTlsPlatformRoots } from '../../../../scripts/fleet/process/tls-platform-roots.mts'
import type { TlsPlatformEnvironment } from '../../../../scripts/fleet/process/tls-platform-roots.mts'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'

const MAX_CA_BYTES = 4_194_304

export async function readTlsBootstrapCaFile(
  file: string,
  optional = false,
): Promise<string | undefined> {
  let handle
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK)
  } catch (error) {
    if (
      optional &&
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return undefined
    }
    throw new Error(`TLS trust source is unreadable: ${file}`)
  }
  try {
    if (!(await handle.stat()).isFile()) {
      throw new Error(`TLS trust source is not a regular file: ${file}`)
    }
    const bytes = Buffer.alloc(MAX_CA_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      const result = await handle.read(
        bytes,
        length,
        bytes.length - length,
        length,
      )
      if (!result.bytesRead) {
        break
      }
      length += result.bytesRead
    }
    if (length > MAX_CA_BYTES) {
      throw new Error(`TLS trust source exceeds 4 MiB: ${file}`)
    }
    return bytes.subarray(0, length).toString('utf8')
  } finally {
    await handle.close()
  }
}

export type TlsBootstrapCaSource = {
  key: string
  path: string
  sha256: string
  environment?: TlsPlatformEnvironment
}

export async function validateTlsBootstrapSources(
  sources: TlsBootstrapCaSource[],
): Promise<void> {
  for (const source of sources) {
    if (source.key.startsWith('node-')) {
      const kind = source.key.slice('node-'.length) as 'bundled' | 'system'
      if (kind === 'system' && !source.environment) {
        throw new Error(
          'Original system CA environment is missing; rerun the setup action.',
        )
      }
      const current = filterTlsCertificates(
        await readTlsPlatformRoots(kind, { environment: source.environment }),
        {
          requireNonEmpty: false,
          skipNonCa: true,
        },
      ).pem
      if (
        crypto.createHash('sha256').update(current).digest('hex') !==
        source.sha256
      ) {
        throw new Error(
          'Node platform CA trust changed; rerun the setup action.',
        )
      }
      continue
    }
    const current = await readTlsBootstrapCaFile(
      source.path,
      source.sha256 === 'missing',
    )
    if (
      source.sha256 === 'missing'
        ? current !== undefined
        : current === undefined ||
          crypto.createHash('sha256').update(current).digest('hex') !==
            source.sha256
    ) {
      throw new Error(
        `TLS trust input changed: ${source.path}; rerun the setup action.`,
      )
    }
  }
}
