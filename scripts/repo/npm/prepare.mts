import { appendFileSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { isMainModule, runMain } from '../cli.mts'
import {
  changelogIntroduction,
  changelogSection,
  chooseReleaseVersion,
  compareVersions,
  insertChangelogSection,
  pinReadmeAssets,
  stableVersions,
} from './prepare-content.mts'
import {
  isGeneratedPullRequest,
  json,
  remoteBranchExists,
  run,
} from './prepare-github.mts'
import type { Pull } from './prepare-github.mts'

type Manifest = { name: string; version: string }
export function resolveVersionFlipAnchor(version: string): string {
  const commits = run('git', [
    'log',
    '--first-parent',
    '--format=%H',
    '-S',
    `"${version}"`,
    '--',
    'package.json',
  ])
    .split('\n')
    .filter(Boolean)
  for (const sha of commits) {
    let current: Manifest
    let previous: Manifest
    try {
      current = JSON.parse(
        run('git', ['show', `${sha}:package.json`]),
      ) as Manifest
      previous = JSON.parse(
        run('git', ['show', `${sha}^:package.json`]),
      ) as Manifest
    } catch {
      continue
    }
    if (current.version !== version || previous.version === version) continue
    const ancestor = spawnSync('git', [
      'merge-base',
      '--is-ancestor',
      sha,
      'HEAD',
    ])
    if (ancestor.status === 0) return sha
  }
  throw new Error(
    `Published baseline ${version} has no version-flip commit, ancestor tag, or gitHead.`,
  )
}

export async function runNpmReleasePreparation(
  env = process.env,
): Promise<void> {
  if (env['GITHUB_ACTIONS'] !== 'true' || env['GITHUB_RUN_ATTEMPT'] !== '1')
    throw new Error(
      'Release preparation only runs on the first attempt of the dispatched GitHub workflow.',
    )
  const repository = env['GITHUB_REPOSITORY']
  const defaultBranch = env['DEFAULT_BRANCH']
  if (!repository || !defaultBranch || !env['GH_TOKEN'] || !env['PR_TOKEN'])
    throw new Error(
      'Preparation requires repository, default branch, release app, and PR app tokens.',
    )
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as Manifest
  const data = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(manifest.name)}`,
    {
      headers: { 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(30_000),
    },
  )
  let versions: Record<string, unknown> = {}
  if (data.status === 200) {
    const record = (await data.json()) as { versions?: unknown }
    if (
      !record.versions ||
      typeof record.versions !== 'object' ||
      Array.isArray(record.versions)
    )
      throw new Error('npm registry response omitted the stable version list.')
    versions = record.versions as Record<string, unknown>
  } else if (data.status !== 404)
    throw new Error(`npm registry lookup failed with HTTP ${data.status}.`)
  const published = stableVersions(versions)
  const highestPublished = published.toSorted(compareVersions).at(-1) ?? '0.0.0'
  let baseline = ''
  if (published.length) {
    const version = published.toSorted(compareVersions).at(-1)!
    const tag = `v${version}`
    const tagExists = run('git', ['tag', '-l', tag]) === tag
    if (tagExists) baseline = run('git', ['rev-parse', `${tag}^{commit}`])
    else {
      const gitHead = (versions[version] as { gitHead?: unknown })?.gitHead
      if (typeof gitHead === 'string' && /^[a-f\d]{40}$/iu.test(gitHead)) {
        const ancestor = spawnSync('git', [
          'merge-base',
          '--is-ancestor',
          gitHead,
          'HEAD',
        ])
        if (ancestor.status !== 0)
          throw new Error(
            `Published baseline ${version} gitHead is not an ancestor.`,
          )
        baseline = gitHead
      } else if (gitHead == null) baseline = resolveVersionFlipAnchor(version)
      else
        throw new Error(`Published baseline ${version} has an invalid gitHead.`)
    }
    const ancestor = spawnSync('git', [
      'merge-base',
      '--is-ancestor',
      baseline,
      'HEAD',
    ])
    if (ancestor.status !== 0)
      throw new Error(
        `Published baseline ${version} is not an ancestor of the release branch.`,
      )
  }
  const commitsRaw = run('git', [
    'log',
    '--format=%H%x09%s',
    ...(baseline ? [`${baseline}..HEAD`] : ['HEAD']),
  ])
  const commits = commitsRaw
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [sha, ...subject] = line.split('\t')
      return { sha: sha!, subject: subject.join('\t') }
    })
  const tags = run('git', ['tag', '-l', 'v*'])
    .split('\n')
    .filter(Boolean)
    .map(t => t.replace(/^v/u, ''))
  const hint = manifest.version.includes('-') ? manifest.version : undefined
  const committedStableVersion = manifest.version.replace(/-[\w.-]+$/u, '')
  let version = chooseReleaseVersion(
    published,
    commits,
    tags,
    hint,
    hint ? highestPublished : committedStableVersion,
  )
  if (
    compareVersions(
      manifest.version.replace(/-[\w.-]+$/u, ''),
      highestPublished,
    ) > 0 &&
    tags.includes(manifest.version)
  ) {
    version = chooseReleaseVersion(
      published,
      commits,
      tags,
      undefined,
      committedStableVersion,
    )
  } else if (
    compareVersions(
      manifest.version.replace(/-[\w.-]+$/u, ''),
      highestPublished,
    ) > 0
  ) {
    const prepared = json<Pull[]>(
      'gh',
      [
        'pr',
        'list',
        '--repo',
        repository,
        '--head',
        `release/prepare-v${manifest.version}`,
        '--base',
        defaultBranch,
        '--state',
        'all',
        '--json',
        'url,state,mergeCommit,author,title,headRefName,baseRefName,headRepository',
      ],
      undefined,
      env['PR_TOKEN'],
    )
    if (prepared.some(pr => pr.state === 'OPEN')) {
      const openPrepared = prepared.find(pr => pr.state === 'OPEN')!
      if (
        !isGeneratedPullRequest(
          openPrepared,
          `release/prepare-v${manifest.version}`,
          defaultBranch,
          repository,
          env['PR_APP_SLUG'] ?? '',
        )
      )
        throw new Error(
          'An open preparation branch exists but is not owned by the configured release PR app.',
        )
      process.stdout.write(
        `Release preparation PR already exists: ${openPrepared.url}\n`,
      )
      if (env['GITHUB_OUTPUT'])
        requireOutput(env['GITHUB_OUTPUT'], 'should-stage', 'false')
      return
    }
    const mergedPreparation = prepared.filter(pr => pr.state === 'MERGED')
    if (
      mergedPreparation.length === 1 &&
      mergedPreparation[0]?.mergeCommit?.oid === env['GITHUB_SHA'] &&
      isGeneratedPullRequest(
        mergedPreparation[0]!,
        `release/prepare-v${manifest.version}`,
        defaultBranch,
        repository,
        env['PR_APP_SLUG'] ?? '',
      )
    )
      version = manifest.version
  }
  let branch = `release/prepare-v${version}`
  let found = json<Pull[]>(
    'gh',
    [
      'pr',
      'list',
      '--repo',
      repository,
      '--head',
      branch,
      '--base',
      defaultBranch,
      '--state',
      'all',
      '--json',
      'url,state,mergeCommit,author,title,headRefName,baseRefName,headRepository',
    ],
    undefined,
    env['PR_TOKEN'],
  )
  let abandoned = 0
  const occupied = new Set(tags)
  while (
    (found.length > 0 &&
      !found.some(pr => pr.state === 'OPEN' || pr.state === 'MERGED')) ||
    (found.length === 0 &&
      remoteBranchExists(repository, branch, env['GH_TOKEN']))
  ) {
    if (++abandoned > 20)
      throw new Error(
        'Too many abandoned release preparation branches; inspect GitHub before retrying.',
      )
    occupied.add(version)
    version = chooseReleaseVersion(
      published,
      commits,
      [...occupied],
      undefined,
      committedStableVersion,
    )
    branch = `release/prepare-v${version}`
    found = json<Pull[]>(
      'gh',
      [
        'pr',
        'list',
        '--repo',
        repository,
        '--head',
        branch,
        '--base',
        defaultBranch,
        '--state',
        'all',
        '--json',
        'url,state,mergeCommit,author,title,headRefName,baseRefName,headRepository',
      ],
      undefined,
      env['PR_TOKEN'],
    )
  }
  const open = found.find(pr => pr.state === 'OPEN')
  if (open) {
    if (
      !isGeneratedPullRequest(
        open,
        branch,
        defaultBranch,
        repository,
        env['PR_APP_SLUG'] ?? '',
      )
    )
      throw new Error(
        'An open preparation branch exists but is not owned by the configured release PR app.',
      )
    process.stdout.write(`Release preparation PR already exists: ${open.url}\n`)
    if (env['GITHUB_OUTPUT'])
      requireOutput(env['GITHUB_OUTPUT'], 'should-stage', 'false')
    return
  }
  const merged = found.filter(pr => pr.state === 'MERGED')
  if (merged.length) {
    if (
      merged.length !== 1 ||
      !merged[0]?.mergeCommit?.oid ||
      merged[0].mergeCommit.oid !== env['GITHUB_SHA'] ||
      !isGeneratedPullRequest(
        merged[0],
        branch,
        defaultBranch,
        repository,
        env['PR_APP_SLUG'] ?? '',
      )
    )
      throw new Error(
        'Merged preparation PR is ambiguous or is not the current default-branch commit; inspect the release PR before retrying.',
      )
    const verification = json<{
      commit?: { verification?: { verified?: boolean } }
    }>(
      'gh',
      ['api', `repos/${repository}/commits/${merged[0].mergeCommit.oid}`],
      undefined,
      env['GH_TOKEN'],
    )
    if (verification.commit?.verification?.verified !== true)
      throw new Error('Merged preparation commit is not GitHub-verified.')
    const tag = `v${version}`
    const occupied = run('git', ['tag', '-l', tag])
    if (occupied)
      throw new Error(
        `Tag ${tag} already exists. Recover that release attempt manually; never restage automatically.`,
      )
    run(
      'gh',
      [
        'api',
        '--method',
        'POST',
        `repos/${repository}/git/refs`,
        '-f',
        `ref=refs/tags/${tag}`,
        '-f',
        `sha=${merged[0].mergeCommit.oid}`,
      ],
      undefined,
      env['GH_TOKEN'],
    )
    process.stdout.write(
      `Reserved ${tag} at verified merged preparation ${merged[0].mergeCommit.oid}.\n`,
    )
    if (env['GITHUB_OUTPUT'])
      requireOutput(env['GITHUB_OUTPUT'], 'should-stage', 'true')
    return
  }
  if (run('git', ['tag', '-l', `v${version}`]))
    throw new Error(
      `Tag v${version} is reserved. Resolve that release attempt manually; versions are never reused.`,
    )
  const files = new Map<string, string>()
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as Record<
    string,
    unknown
  >
  pkg['version'] = version
  files.set('package.json', `${JSON.stringify(pkg, null, 2)}\n`)
  const plugin = JSON.parse(readFileSync('manifest.json', 'utf8')) as Record<
    string,
    unknown
  >
  plugin['version'] = version
  files.set('manifest.json', `${JSON.stringify(plugin, null, 2)}\n`)
  const changelog = baseline
    ? run('git', ['show', `${baseline}:CHANGELOG.md`])
    : changelogIntroduction(readFileSync('CHANGELOG.md', 'utf8'))
  files.set(
    'CHANGELOG.md',
    insertChangelogSection(changelog, changelogSection(version, commits)),
  )
  const readme = readFileSync('README.md', 'utf8')
  files.set('README.md', pinReadmeAssets(readme, version))
  const head = run('git', ['rev-parse', 'HEAD'])
  const additions = [...files].map(([path, contents]) => ({ path, contents }))
  run(
    'gh',
    [
      'api',
      '--method',
      'POST',
      `repos/${repository}/git/refs`,
      '-f',
      `ref=refs/heads/${branch}`,
      '-f',
      `sha=${head}`,
    ],
    undefined,
    env['GH_TOKEN'],
  )
  const mutation = `mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid url } } }`
  const input = JSON.stringify({
    query: mutation,
    variables: {
      input: {
        branch: { repositoryNameWithOwner: repository, branchName: branch },
        message: {
          headline: `chore(release): prepare v${version}`,
          body: `Release preparation generated by publish:npm.\n\nBaseline: ${baseline || 'unpublished package'}\nSource: ${head}`,
        },
        expectedHeadOid: head,
        fileChanges: {
          additions: additions.map(file => ({
            ...file,
            contents: Buffer.from(file.contents).toString('base64'),
          })),
        },
      },
    },
  })
  const graphql = json<{
    data?: { createCommitOnBranch?: { commit?: { oid?: string } } }
    errors?: unknown[]
  }>('gh', ['api', 'graphql', '--input', '-'], input, env['GH_TOKEN'])
  if (
    graphql.errors?.length ||
    !graphql.data?.createCommitOnBranch?.commit?.oid
  )
    throw new Error('GitHub did not create the signed preparation commit.')
  const commitSha = graphql.data.createCommitOnBranch.commit.oid
  const commitVerification = json<{
    commit?: { verification?: { verified?: boolean } }
  }>(
    'gh',
    ['api', `repos/${repository}/commits/${commitSha}`],
    undefined,
    env['GH_TOKEN'],
  )
  if (commitVerification.commit?.verification?.verified !== true)
    throw new Error(
      'GitHub did not verify the signed release preparation commit.',
    )
  const created = run(
    'gh',
    [
      'pr',
      'create',
      '--repo',
      repository,
      '--base',
      defaultBranch,
      '--head',
      branch,
      '--title',
      `chore(release): prepare v${version}`,
      '--body',
      `Generated release preparation for ${manifest.name}@${version}.\n\nReview and merge this PR. Then run \`pnpm run publish:npm\` again to stage the release.`,
    ],
    undefined,
    env['PR_TOKEN'],
  )
  process.stdout.write(`Created release preparation PR: ${created}\n`)
  if (env['GITHUB_OUTPUT'])
    requireOutput(env['GITHUB_OUTPUT'], 'should-stage', 'false')
}

export function requireOutput(file: string, key: string, value: string): void {
  appendFileSync(file, `${key}=${value}\n`)
}

if (isMainModule(import.meta.url))
  runMain(() => runNpmReleasePreparation(), {
    describe:
      'Prepares a version bump pull request or resumes a merged npm release.',
    help: 'Usage: node scripts/repo/npm/prepare.mts',
  })
