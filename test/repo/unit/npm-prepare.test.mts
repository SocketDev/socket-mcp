import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { normalizePath } from '@socketsecurity/lib/paths/normalize'

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawnSync: spawn }))
let packageVersion = '0.3.0'
let releasePolicy: Record<string, string> = {
  mode: 'stable-from-hint',
  distTag: 'latest',
}
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (args[0] === 'package.json')
        return JSON.stringify({
          name: '@example/harbor',
          version: packageVersion,
        })
      if (
        typeof args[0] === 'string' &&
        normalizePath(args[0]).endsWith('/.config/release.json')
      )
        return JSON.stringify(releasePolicy)
      if (args[0] === 'manifest.json')
        return JSON.stringify({ name: 'Harbor', version: '0.3.0' })
      if (args[0] === 'CHANGELOG.md')
        return '# Changelog\n\nIntro\n\n## unpublished attempt\n'
      if (args[0] === 'README.md')
        return `![asset](https://raw.githubusercontent.com/${REPOSITORY}/HEAD/assets/repo/coverage.svg)`
      return actual.readFileSync(...args)
    },
  }
})

import {
  resolveVersionFlipAnchor,
  runNpmReleasePreparation,
} from '../../../scripts/repo/npm/prepare.mts'
import {
  changelogIntroduction,
  changelogSection,
  chooseReleaseVersion,
  insertChangelogSection,
  latestPublishedBaseline,
  parseConventionalCommit,
  stableVersions,
} from '../../../scripts/repo/npm/prepare-content.mts'
import { parseReleasePolicy } from '../../../scripts/repo/npm/release-policy.mts'
import { REPOSITORY } from './npm-repository.mts'

const source = 'a'.repeat(40)
const merge = 'c'.repeat(40)
const app = 'socket-pr-bot'
const repo = REPOSITORY
const pull = (state: string, version = '0.3.0') => ({
  url: `https://github.com/${REPOSITORY}/pull/100`,
  state,
  title: `chore(release): prepare v${version}`,
  headRefName: `release/prepare-v${version}`,
  baseRefName: 'main',
  headRepository: { nameWithOwner: repo },
  author: { is_bot: true, login: `app/${app}` },
  mergeCommit: state === 'MERGED' ? { oid: merge } : undefined,
})

afterEach(() => {
  vi.unstubAllGlobals()
  spawn.mockReset()
  packageVersion = '0.3.0'
  releasePolicy = { mode: 'stable-from-hint', distTag: 'latest' }
})

describe('release preparation policy', () => {
  it('parses Conventional Commit types, scopes, and breaking markers', () => {
    expect(parseConventionalCommit('feat(api)!: add authentication')).toEqual({
      type: 'feat',
      scope: 'api',
      breaking: true,
      description: 'add authentication',
    })
    expect(
      parseConventionalCommit('maintenance without a type'),
    ).toBeUndefined()
  })

  it('includes only fix and feat commits in generated changelog entries', () => {
    expect(
      changelogSection(
        '1.3.0',
        [
          { sha: source, subject: 'feat: add release flow' },
          { sha: 'b'.repeat(40), subject: 'fix(cli): repair output' },
          { sha: 'c'.repeat(40), subject: 'chore: update CI' },
          { sha: 'd'.repeat(40), subject: 'docs: clarify setup' },
        ],
        '2026-11-11',
      ),
    ).toContain('feat: add release flow')
    const section = changelogSection(
      '1.3.0',
      [
        { sha: source, subject: 'feat: add release flow' },
        { sha: 'b'.repeat(40), subject: 'fix(cli): repair output' },
        { sha: 'c'.repeat(40), subject: 'chore: update CI' },
        { sha: 'd'.repeat(40), subject: 'docs: clarify setup' },
      ],
      '2026-11-11',
    )
    expect(section).toContain('fix(cli): repair output')
    expect(section).not.toContain('chore:')
    expect(section).not.toContain('docs:')
  })

  it('uses only actually published stable versions, including 0.0.0', () => {
    expect(
      stableVersions({
        '0.0.0': {},
        '0.3.0-stage.1': {},
        '1.0.0-beta.1': {},
        '0.9.3': {},
      }),
    ).toEqual(['0.0.0', '0.9.3'])
  })

  it('bumps minor for feature commits and patch for other changes', () => {
    expect(
      chooseReleaseVersion(
        ['1.2.3'],
        [{ sha: source, subject: 'fix: repair a bug' }],
        [],
      ),
    ).toBe('1.2.4')
    expect(
      chooseReleaseVersion(
        ['1.2.3'],
        [{ sha: source, subject: 'perf: improve startup' }],
        [],
      ),
    ).toBe('1.2.4')
    expect(
      chooseReleaseVersion(
        ['1.2.3'],
        [{ sha: source, subject: 'chore: update CI config' }],
        [],
      ),
    ).toBe('1.2.4')
    expect(
      chooseReleaseVersion(
        ['1.2.3'],
        [{ sha: source, subject: 'docs: clarify setup' }],
        [],
      ),
    ).toBe('1.2.4')
    expect(
      chooseReleaseVersion(
        ['1.2.3'],
        [{ sha: source, subject: 'feat(plugin): add upload support' }],
        [],
      ),
    ).toBe('1.3.0')
  })

  it('skips reserved candidates, respects the committed version floor, and strips prerelease hints', () => {
    expect(
      chooseReleaseVersion(
        ['1.2.3'],
        [{ sha: source, subject: 'fix: repair' }],
        ['1.2.4'],
        undefined,
        '1.2.4',
      ),
    ).toBe('1.2.5')
    expect(chooseReleaseVersion(['1.2.3'], [], [], '1.3.0-rc.2', '1.2.3')).toBe(
      '1.3.0',
    )
  })

  it('keeps prerelease-only tracks on their hinted SemVer core', () => {
    const policy = parseReleasePolicy({
      mode: 'prerelease-only',
      versionHint: '2.1.0',
      identifier: 'rc',
      distTag: 'prerelease-2.1.0',
    })
    expect(
      chooseReleaseVersion(
        ['0.3.0'],
        [{ sha: source, subject: 'feat: add release flow' }],
        ['2.1.0-rc.2'],
        undefined,
        undefined,
        policy,
        ['0.3.0', '2.1.0-rc.1'],
      ),
    ).toBe('2.1.0-rc.3')
    expect(
      chooseReleaseVersion(['0.3.0'], [], [], undefined, undefined, policy),
    ).toBe('2.1.0-rc.0')
    expect(
      chooseReleaseVersion(['0.3.0'], [], [], undefined, '2.1.0-rc.4', policy, [
        '0.3.0',
      ]),
    ).toBe('2.1.0-rc.5')
  })

  it('uses the last published version on the selected release track as its baseline', () => {
    const versions = {
      '0.3.0': {},
      '2.1.0-rc.1': {},
      '2.1.0-rc.4': {},
      '2.2.0-rc.2': {},
    }
    expect(
      latestPublishedBaseline(versions, {
        mode: 'stable-from-hint',
        distTag: 'latest',
      }),
    ).toBe('0.3.0')
    expect(
      latestPublishedBaseline(versions, {
        mode: 'prerelease-only',
        versionHint: '2.1.0',
        identifier: 'rc',
        distTag: 'prerelease-2.1.0',
      }),
    ).toBe('2.1.0-rc.4')
    expect(
      latestPublishedBaseline(
        { '0.3.0': {}, '0.3.1': {} },
        {
          mode: 'prerelease-only',
          versionHint: '2.1.0',
          identifier: 'rc',
          distTag: 'prerelease-2.1.0',
        },
      ),
    ).toBe('0.3.1')
  })

  it('rejects invalid prerelease-only release policy values', () => {
    expect(() =>
      parseReleasePolicy({
        mode: 'prerelease-only',
        versionHint: '2.1.0-beta.1',
        identifier: 'rc',
        distTag: 'prerelease-2.1.0',
      }),
    ).toThrow('Release policy mode')
    expect(() =>
      parseReleasePolicy({ mode: 'future-mode', distTag: 'latest' }),
    ).toThrow('Release policy mode')
  })

  it('inserts generated entries below the changelog introduction and can discard unpublished attempts', () => {
    const text = '# Changelog\n\nIntro\n\n## old release\n\nold text\n'
    const intro = changelogIntroduction(text)
    expect(
      insertChangelogSection(
        intro,
        changelogSection(
          '1.3.0',
          [{ sha: source, subject: 'fix: repair' }],
          '2026-11-11',
        ),
      ),
    ).toContain('Intro\n\n## [1.3.0]')
    expect(intro).not.toContain('old release')
  })
})

describe('preparation side effects', () => {
  const outDir = mkdtempSync(path.join(tmpdir(), 'npm-prep-test-'))
  afterAll(() => rmSync(outDir, { recursive: true, force: true }))

  it('resolves the published manifest version transition when npm has no gitHead or tag', () => {
    spawn.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === 'log') return { status: 0, stdout: source }
      if (args[0] === 'show' && args[1] === `${source}:package.json`)
        return { status: 0, stdout: '{"version":"0.3.0"}' }
      if (args[0] === 'show' && args[1] === `${source}^:package.json`)
        return { status: 0, stdout: '{"version":"0.2.1"}' }
      if (args[0] === 'merge-base') return { status: 0, stdout: '' }
      throw new Error(args.join(' '))
    })
    expect(resolveVersionFlipAnchor('0.3.0')).toBe(source)
  })
  const env = {
    GH_TOKEN: 'release-token',
    PR_TOKEN: 'pr-token',
    PR_APP_SLUG: app,
    GITHUB_REPOSITORY: repo,
    DEFAULT_BRANCH: 'main',
    GITHUB_SHA: merge,
    GITHUB_ACTIONS: 'true',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_OUTPUT: path.join(outDir, 'output'),
  }

  function baseline(): void {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ versions: { '0.2.1': { gitHead: source } } }),
          ),
        ),
    )
    spawn.mockImplementation((command: string, args: string[]) => {
      if (command === 'git') {
        if (args[0] === 'tag' && args[1] === '-l' && args[2] === 'v0.2.1')
          return { status: 0, stdout: 'v0.2.1' }
        if (
          args[0] === 'tag' &&
          args[1] === '-l' &&
          args[2]?.startsWith('v0.3.')
        )
          return { status: 0, stdout: '' }
        if (args[0] === 'tag' && args[1] === '-l')
          return { status: 0, stdout: 'v0.2.1' }
        if (args[0] === 'rev-parse') return { status: 0, stdout: source }
        if (args[0] === 'merge-base') return { status: 0, stdout: '' }
        if (args[0] === 'log')
          return { status: 0, stdout: `${source}\tfix: repair issue` }
        if (args[0] === 'show')
          return {
            status: 0,
            stdout: '# Changelog\n\nIntro\n\n## [0.2.1] - 2026-01-01\n',
          }
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'list')
        return { status: 0, stdout: '[]' }
      if (
        command === 'gh' &&
        args[0] === 'api' &&
        args[1]?.includes('matching-refs')
      )
        return { status: 0, stdout: '[]' }
      if (
        command === 'gh' &&
        args[0] === 'api' &&
        args.at(-1)?.includes('/commits/')
      )
        return {
          status: 0,
          stdout: JSON.stringify({
            commit: { verification: { verified: true } },
          }),
        }
      if (command === 'gh' && args.includes('graphql'))
        return {
          status: 0,
          stdout: JSON.stringify({
            data: { createCommitOnBranch: { commit: { oid: 'd'.repeat(40) } } },
          }),
        }
      if (command === 'gh' && args.includes('create'))
        return {
          status: 0,
          stdout: `https://github.com/${REPOSITORY}/pull/101`,
        }
      if (command === 'gh') return { status: 0, stdout: '{}' }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`)
    })
  }

  afterEach(() => {
    writeFileSync(env.GITHUB_OUTPUT, '')
  })

  it.each([
    {
      scenario: 'main advanced',
      currentSha: 'e'.repeat(40),
      tagReserved: false,
      shouldStage: false,
    },
    {
      scenario: 'the merged version tag is already reserved',
      currentSha: merge,
      tagReserved: true,
      shouldStage: false,
    },
    {
      scenario: 'the merged commit is still current and untagged',
      currentSha: merge,
      tagReserved: false,
      shouldStage: true,
    },
  ])(
    'handles prerelease recovery when $scenario',
    async ({ currentSha, tagReserved, shouldStage }) => {
      packageVersion = '2.1.0-rc.1'
      releasePolicy = {
        mode: 'prerelease-only',
        versionHint: '2.1.0',
        identifier: 'rc',
        distTag: 'prerelease-2.1.0',
      }
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify({ versions: { '0.2.1': {} } })),
          ),
      )
      const mergedPreparation = JSON.stringify([pull('MERGED', '2.1.0-rc.1')])
      const currentEnv = { ...env, GITHUB_SHA: currentSha }
      spawn.mockImplementation((command: string, args: string[]) => {
        if (command === 'git') {
          if (args[0] === 'tag' && args[1] === '-l' && args[2] === 'v*')
            return {
              status: 0,
              stdout: ['v0.2.1', ...(tagReserved ? ['v2.1.0-rc.1'] : [])].join(
                '\n',
              ),
            }
          if (args[0] === 'tag' && args[1] === '-l' && args[2] === 'v0.2.1')
            return { status: 0, stdout: 'v0.2.1' }
          if (args[0] === 'tag' && args[1] === '-l')
            return { status: 0, stdout: '' }
          if (args[0] === 'log')
            return { status: 0, stdout: `${source}\tfeat: advance release` }
          if (args[0] === 'rev-parse') return { status: 0, stdout: source }
          if (args[0] === 'merge-base') return { status: 0, stdout: '' }
          if (args[0] === 'show')
            return { status: 0, stdout: '# Changelog\n\nIntro\n' }
        }
        if (command === 'gh' && args[0] === 'pr' && args[1] === 'list')
          return {
            status: 0,
            stdout: args.includes('release/prepare-v2.1.0-rc.1')
              ? mergedPreparation
              : '[]',
          }
        if (
          command === 'gh' &&
          args[0] === 'api' &&
          args[1]?.includes('matching-refs')
        )
          return { status: 0, stdout: '[]' }
        if (command === 'gh' && args.at(-1)?.includes('/commits/'))
          return {
            status: 0,
            stdout: JSON.stringify({
              commit: { verification: { verified: true } },
            }),
          }
        if (command === 'gh' && args.includes('graphql'))
          return {
            status: 0,
            stdout: JSON.stringify({
              data: {
                createCommitOnBranch: { commit: { oid: 'd'.repeat(40) } },
              },
            }),
          }
        if (command === 'gh' && args.includes('create'))
          return {
            status: 0,
            stdout: `https://github.com/${REPOSITORY}/pull/101`,
          }
        if (command === 'gh') return { status: 0, stdout: '{}' }
        throw new Error(`Unexpected command: ${command} ${args.join(' ')}`)
      })
      await runNpmReleasePreparation(currentEnv)
      const output = readFileSync(env.GITHUB_OUTPUT, 'utf8')
      expect(output).toContain(`should-stage=${String(shouldStage)}`)
      if (shouldStage) {
        expect(
          spawn.mock.calls.some(call =>
            call[1]?.includes('ref=refs/tags/v2.1.0-rc.1'),
          ),
        ).toBe(true)
        expect(
          spawn.mock.calls.some(call => call[1]?.includes('graphql')),
        ).toBe(false)
      } else {
        const graphql = spawn.mock.calls.find(call =>
          call[1]?.includes('graphql'),
        )
        expect(graphql?.[2]?.input).toContain('2.1.0-rc.2')
      }
    },
  )

  it('creates a GitHub-signed preparation commit and opens a PR without merging', async () => {
    baseline()
    await runNpmReleasePreparation(env)
    const graphql = spawn.mock.calls.find(call => call[1]?.includes('graphql'))
    expect(graphql?.[2]?.input).toContain('createCommitOnBranch')
    expect(spawn.mock.calls.some(call => call[1]?.[1] === 'create')).toBe(true)
    expect(readFileSync(env.GITHUB_OUTPUT, 'utf8')).toContain(
      'should-stage=false',
    )
    expect(spawn.mock.calls.some(call => call[1]?.includes('merge'))).toBe(
      false,
    )
  })

  it('reserves a tag only for the exact signed merged preparation commit', async () => {
    baseline()
    const merged = JSON.stringify([pull('MERGED')])
    spawn.mockImplementation((command: string, args: string[]) => {
      if (command === 'git') {
        if (args[0] === 'tag' && args.at(-1) === 'v0.3.0')
          return { status: 0, stdout: '' }
        if (
          args[0] === 'tag' &&
          args[1] === '-l' &&
          args[2]?.startsWith('v0.3.')
        )
          return { status: 0, stdout: '' }
        if (args[0] === 'tag' && args[1] === '-l' && args[2] === 'v0.2.1')
          return { status: 0, stdout: 'v0.2.1' }
        if (args[0] === 'tag' && args[1] === '-l')
          return { status: 0, stdout: 'v0.2.1' }
        if (args[0] === 'rev-parse') return { status: 0, stdout: source }
        if (args[0] === 'merge-base') return { status: 0, stdout: '' }
        if (args[0] === 'log')
          return { status: 0, stdout: `${source}\tfix: repair issue` }
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'list')
        return { status: 0, stdout: merged }
      if (command === 'gh' && args.at(-1)?.includes('/commits/'))
        return {
          status: 0,
          stdout: JSON.stringify({
            commit: { verification: { verified: true } },
          }),
        }
      if (command === 'gh') return { status: 0, stdout: '{}' }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`)
    })
    await runNpmReleasePreparation(env)
    expect(
      spawn.mock.calls.some(call => call[1]?.includes('ref=refs/tags/v0.3.0')),
    ).toBe(true)
    expect(readFileSync(env.GITHUB_OUTPUT, 'utf8')).toContain(
      'should-stage=true',
    )
  })

  it('stops before reserving a tag when GitHub has not verified the merge commit', async () => {
    baseline()
    spawn.mockImplementation((command: string, args: string[]) => {
      if (command === 'git') {
        if (args[0] === 'tag' && args.at(-1) === 'v0.3.0')
          return { status: 0, stdout: '' }
        if (args[0] === 'tag' && args[2]?.startsWith('v0.3.'))
          return { status: 0, stdout: '' }
        if (args[0] === 'tag') return { status: 0, stdout: 'v0.2.1' }
        if (args[0] === 'rev-parse') return { status: 0, stdout: source }
        if (args[0] === 'merge-base') return { status: 0, stdout: '' }
        if (args[0] === 'log')
          return { status: 0, stdout: `${source}\tfix: repair issue` }
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'list')
        return { status: 0, stdout: JSON.stringify([pull('MERGED')]) }
      if (command === 'gh' && args.at(-1)?.includes('/commits/'))
        return {
          status: 0,
          stdout: JSON.stringify({
            commit: { verification: { verified: false } },
          }),
        }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`)
    })
    await expect(runNpmReleasePreparation(env)).rejects.toThrow(
      /not GitHub-verified/u,
    )
    expect(
      spawn.mock.calls.some(call => call[1]?.includes('ref=refs/tags/v0.3.0')),
    ).toBe(false)
  })
})
