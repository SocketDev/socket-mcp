import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { spawn, readTar } = vi.hoisted(() => ({
  spawn: vi.fn(),
  readTar: vi.fn(),
}))
vi.mock('node:child_process', () => ({
  spawnSync: spawn,
  execFileSync: readTar,
}))

import {
  parseNpmStageId,
  run,
  runNpmStagePublish,
} from '../../../scripts/repo/npm/publish.mts'
import { validateNpmRelease } from '../../../scripts/repo/npm/validate.mts'

afterEach(() => {
  vi.unstubAllGlobals()
  spawn.mockReset()
  readTar.mockReset()
})

const stageId = '12345678-1234-4123-8123-123456789abc'

describe('npm release validation', () => {
  it('accepts a stable release from the default branch', () => {
    expect(() =>
      validateNpmRelease(
        { name: '@example/pkg', version: '1.2.3' },
        { defaultBranch: 'main', ref: 'refs/heads/main', distTag: 'latest' },
      ),
    ).not.toThrow()
  })

  it('rejects a non-default branch and invalid versions', () => {
    expect(() =>
      validateNpmRelease(
        { name: '@example/pkg', version: '1.2.3' },
        { defaultBranch: 'main', ref: 'refs/heads/topic', distTag: 'latest' },
      ),
    ).toThrow()
    expect(() =>
      validateNpmRelease(
        { name: '@example/pkg', version: '1.2' },
        { defaultBranch: 'main', ref: 'refs/heads/main', distTag: 'latest' },
      ),
    ).toThrow()
  })

  it('requires prerelease-only policy to keep its prerelease version and tag', () => {
    const policy = {
      mode: 'prerelease-only' as const,
      versionHint: '2.1.0',
      identifier: 'rc',
      distTag: 'prerelease-2.1.0',
    }
    const config = {
      defaultBranch: 'main',
      ref: 'refs/heads/main',
      distTag: 'prerelease-2.1.0',
      policy,
    }
    expect(() =>
      validateNpmRelease(
        { name: '@example/pkg', version: '2.1.0-rc.3' },
        config,
      ),
    ).not.toThrow()
    expect(() =>
      validateNpmRelease({ name: '@example/pkg', version: '2.1.0' }, config),
    ).toThrow('prerelease track')
    expect(() =>
      validateNpmRelease(
        { name: '@example/pkg', version: '2.2.0-rc.0' },
        config,
      ),
    ).toThrow('prerelease track')
    expect(() =>
      validateNpmRelease(
        { name: '@example/pkg', version: '2.1.0-rc.3' },
        { ...config, distTag: 'latest' },
      ),
    ).toThrow('requires the prerelease-2.1.0 dist-tag')
  })

  it('does not treat a prerelease suffix as a stable version hint at publish time', () => {
    expect(() =>
      validateNpmRelease(
        { name: '@example/pkg', version: '0.3.1-beta.0' },
        { defaultBranch: 'main', ref: 'refs/heads/main', distTag: 'latest' },
      ),
    ).toThrow('Stable release policy does not allow a prerelease version')
  })
})

describe('npm stage output', () => {
  it('reads the exact stage ID from pnpm JSON', () => {
    const json = JSON.stringify({
      '@example/pkg': {
        id: '@example/pkg@1.2.3',
        name: '@example/pkg',
        version: '1.2.3',
        stageId,
      },
    })
    expect(parseNpmStageId(json, '@example/pkg', '1.2.3')).toBe(stageId)
  })

  it('rejects missing, duplicate, malformed, or mismatched stage records', () => {
    for (const value of [
      '',
      '{}',
      JSON.stringify({ pkg: { name: 'wrong', version: '1.2.3', stageId } }),
      JSON.stringify([
        { name: 'pkg', version: '1.2.3', stageId },
        { name: 'pkg', version: '1.2.3', stageId },
      ]),
      JSON.stringify({
        pkg: { name: 'pkg', version: '1.2.3', stageId: 'invalid' },
      }),
    ]) {
      expect(() => parseNpmStageId(value, 'pkg', '1.2.3')).toThrow()
    }
  })
})

describe('npm staging guards and upload sequence', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
    name: string
    version: string
  }
  const env = {
    GITHUB_ACTIONS: 'true',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_REF: 'refs/heads/main',
    DEFAULT_BRANCH: 'main',
    DIST_TAG: 'latest',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/token',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'token',
  }

  it('checks guards before registry access or packing', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      runNpmStagePublish({ ...env, GITHUB_RUN_ATTEMPT: '2' }),
    ).rejects.toThrow()
    await expect(
      runNpmStagePublish({ ...env, NPM_TOKEN: 'token' }),
    ).rejects.toThrow()
    await expect(
      runNpmStagePublish({ ...env, ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' }),
    ).rejects.toThrow()
    await expect(
      runNpmStagePublish({ ...env, GITHUB_REF: 'refs/heads/topic' }),
    ).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('packs once, validates that archive, stages those exact bytes, and cleans up', async () => {
    const stageId = '12345678-1234-4123-8123-123456789abc'
    const summaryDirectory = mkdtempSync(
      path.join(tmpdir(), 'npm-stage-summary-'),
    )
    const summaryPath = path.join(summaryDirectory, 'summary.md')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{"versions":{}}')),
    )
    readTar.mockImplementation((_command: string, args: string[]) =>
      args[0] === '-tzf'
        ? 'package/package.json\npackage/CHANGELOG.md\npackage/dist/index.cjs\npackage/dist/socket-gate/index.cjs\n'
        : JSON.stringify(manifest),
    )
    let packedPath = ''
    spawn.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === 'pack') {
        const directory = args[args.indexOf('--pack-destination') + 1]!
        packedPath = path.join(
          directory,
          `${manifest.name.replace(/^@/u, '').replace('/', '-')}-${manifest.version}.tgz`,
        )
        writeFileSync(packedPath, 'same-bytes')
        return { status: 0, stdout: '', stderr: '' }
      }
      expect(args.slice(0, 2)).toEqual(['stage', 'publish'])
      expect(args).toContain('--json')
      expect(readFileSync(args[2]!, 'utf8')).toBe('same-bytes')
      return {
        status: 0,
        stdout: JSON.stringify({
          [manifest.name]: {
            name: manifest.name,
            version: manifest.version,
            stageId,
          },
        }),
        stderr: '',
      }
    })
    try {
      const result = await runNpmStagePublish({
        ...env,
        GITHUB_STEP_SUMMARY: summaryPath,
      })
      expect(result).toEqual({
        name: manifest.name,
        version: manifest.version,
        tag: 'latest',
        stageId,
      })
      expect(spawn).toHaveBeenCalledTimes(2)
      expect(existsSync(path.dirname(packedPath))).toBe(false)
      const summary = readFileSync(summaryPath, 'utf8')
      expect(summary).toContain(`- Stage ID: \`${stageId}\``)
      expect(summary).toContain(`pnpm run approve:npm ${stageId}`)
    } finally {
      rmSync(summaryDirectory, { recursive: true, force: true })
    }
  })

  it('validates the packed package identity before staging', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{"versions":{}}')),
    )
    readTar.mockImplementation((_command: string, args: string[]) =>
      args[0] === '-tzf'
        ? 'package/package.json\npackage/CHANGELOG.md\npackage/dist/index.cjs\n'
        : JSON.stringify({ ...manifest, name: 'wrong-package' }),
    )
    spawn.mockImplementation((_command: string, args: string[]) => {
      const directory = args[args.indexOf('--pack-destination') + 1]!
      writeFileSync(
        path.join(
          directory,
          `${manifest.name.replace(/^@/u, '').replace('/', '-')}-${manifest.version}.tgz`,
        ),
        'bad-package',
      )
      return { status: 0, stdout: '', stderr: '' }
    })
    await expect(runNpmStagePublish(env)).rejects.toThrow(
      'Packed package identity',
    )
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0]?.[1]).toContain('pack')
  })

  it('cleans up the packed archive when npm staging fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{"versions":{}}')),
    )
    readTar.mockImplementation((_command: string, args: string[]) =>
      args[0] === '-tzf'
        ? 'package/package.json\npackage/CHANGELOG.md\npackage/dist/index.cjs\npackage/dist/socket-gate/index.cjs\n'
        : JSON.stringify(manifest),
    )
    let packedDirectory = ''
    spawn.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === 'pack') {
        packedDirectory = args[args.indexOf('--pack-destination') + 1]!
        writeFileSync(
          path.join(
            packedDirectory,
            `${manifest.name.replace(/^@/u, '').replace('/', '-')}-${manifest.version}.tgz`,
          ),
          'same-bytes',
        )
        return { status: 0, stdout: '', stderr: '' }
      }
      return { status: 1, stdout: '', stderr: 'stage upload failed' }
    })
    await expect(runNpmStagePublish(env)).rejects.toThrow(
      'failed with status 1',
    )
    expect(packedDirectory).not.toBe('')
    expect(existsSync(packedDirectory)).toBe(false)
  })

  it('refuses an already published version without packing', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ versions: { [manifest.version]: {} } }),
          ),
        ),
    )
    await expect(runNpmStagePublish(env)).rejects.toThrow(/already public/u)
    expect(spawn).not.toHaveBeenCalled()
  })
})

describe('process output', () => {
  it('prints stdout and stderr separately and returns JSON stdout', () => {
    spawn.mockReturnValue({
      status: 0,
      stdout: '{"id":"ok"}',
      stderr: 'notice',
    })
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      expect(run('pnpm', ['stage', 'publish'], {})).toBe('{"id":"ok"}')
      expect(stdout).toHaveBeenCalledWith('{"id":"ok"}')
      expect(stderr).toHaveBeenCalledWith('notice')
    } finally {
      stdout.mockRestore()
      stderr.mockRestore()
    }
  })

  it('throws when the command exits unsuccessfully', () => {
    spawn.mockReturnValue({ status: 1, stdout: '', stderr: 'failed' })
    expect(() => run('pnpm', ['pack'], {})).toThrow(
      'pnpm pack failed with status 1.',
    )
  })
})
