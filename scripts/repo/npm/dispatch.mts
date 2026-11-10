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
      `Dispatched npm release preparation from ${branch}. Check Actions; merge its preparation PR, then run pnpm run publish:npm again.\n`,
    )
}

if (isMainModule(import.meta.url))
  runMain(dispatchNpmPublish, {
    describe: 'Prepares or stages an npm release through GitHub Actions.',
    help: 'Usage: pnpm run publish:npm',
  })
