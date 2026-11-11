import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  parseReleasePolicy,
  readReleasePolicy,
} from '../../../scripts/repo/npm/release-policy.mts'

const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'socket-mcp-release-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true })))
})

describe('release policy', () => {
  it('accepts an rc track with its version-specific prerelease dist-tag', () => {
    expect(
      parseReleasePolicy({
        mode: 'prerelease-only',
        versionHint: '2.1.0',
        identifier: 'rc',
        distTag: 'prerelease-2.1.0',
      }),
    ).toEqual({
      mode: 'prerelease-only',
      versionHint: '2.1.0',
      identifier: 'rc',
      distTag: 'prerelease-2.1.0',
    })
  })

  it.each(['latest', 'next', 'rc', 'prerelease-2.2.0'])(
    'rejects %s for a prerelease-only track',
    distTag => {
      expect(() =>
        parseReleasePolicy({
          mode: 'prerelease-only',
          versionHint: '2.1.0',
          identifier: 'rc',
          distTag,
        }),
      ).toThrow('must use the prerelease-2.1.0 dist-tag')
    },
  )

  it('fails closed when no release config exists', async () => {
    const root = await makeRoot()
    expect(() => readReleasePolicy(root)).toThrow(
      'Release configuration not found',
    )
  })

  it.each(['.config/release.json', 'release.json', '.release.json'])(
    'reads release config from %s',
    async filename => {
      const root = await makeRoot()
      if (filename.startsWith('.config/'))
        await mkdir(path.join(root, '.config'))
      await writeFile(
        path.join(root, filename),
        JSON.stringify({ mode: 'stable-from-hint', distTag: 'latest' }),
      )

      expect(readReleasePolicy(root)).toEqual({
        mode: 'stable-from-hint',
        distTag: 'latest',
      })
    },
  )

  it('rejects conflicting release config paths', async () => {
    const root = await makeRoot()
    await mkdir(path.join(root, '.config'))
    const config = JSON.stringify({
      mode: 'stable-from-hint',
      distTag: 'latest',
    })
    await Promise.all([
      writeFile(path.join(root, '.config/release.json'), config),
      writeFile(path.join(root, 'release.json'), config),
    ])

    expect(() => readReleasePolicy(root)).toThrow(
      'Found multiple release configurations',
    )
  })
})
