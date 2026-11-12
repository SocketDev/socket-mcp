import { spawnSync } from 'node:child_process'
import { isMainModule, runMain } from '../cli.mts'

function capture(args: string[]): string {
  const result = spawnSync('gh', args, { encoding: 'utf8' })
  if (result.status !== 0)
    throw new Error(`gh ${args.join(' ')} failed: ${result.stderr ?? ''}`)
  return result.stdout.trim()
}

export function dispatchNpmPublish(): void {
  const repository = capture([
    'repo',
    'view',
    '--json',
    'nameWithOwner',
    '--jq',
    '.nameWithOwner',
  ])
  const branch = capture([
    'repo',
    'view',
    '--json',
    'defaultBranchRef',
    '--jq',
    '.defaultBranchRef.name',
  ])
  const result = spawnSync(
    'gh',
    [
      'workflow',
      'run',
      'publish-npm.yml',
      '--repo',
      repository,
      '--ref',
      branch,
    ],
    { stdio: 'inherit' },
  )
  if (result.status !== 0) process.exitCode = result.status ?? 1
  else
    process.stdout.write(
      `Dispatched the npm release workflow from ${branch}. The first run prepares a version PR; merge it, then run pnpm run publish:npm again to stage the release. This run does not publish the package. Check Actions for its result.\n`,
    )
}

if (isMainModule(import.meta.url))
  runMain(dispatchNpmPublish, {
    describe: 'Prepares or stages an npm release through GitHub Actions.',
    help: 'Usage: pnpm run publish:npm',
  })
