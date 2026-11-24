import { spawnSync } from 'node:child_process'

export type Pull = {
  url: string
  state: string
  mergeCommit?: { oid: string }
  author?: { login: string; is_bot?: boolean }
  title?: string
  headRefName?: string
  baseRefName?: string
  headRepository?: { nameWithOwner?: string }
}

export function isGeneratedPullRequest(
  pull: Pull,
  branch: string,
  base: string,
  repository: string,
  appSlug: string,
): boolean {
  return (
    pull.title ===
      `chore(release): prepare ${branch.replace('release/prepare-', '')}` &&
    pull.headRefName === branch &&
    pull.baseRefName === base &&
    pull.headRepository?.nameWithOwner === repository &&
    pull.author?.is_bot === true &&
    pull.author.login === `app/${appSlug}`
  )
}

export function run(
  command: string,
  args: string[],
  input?: string,
  token?: string,
): string {
  const env = token ? { ...process.env, GH_TOKEN: token } : process.env
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    input,
    env,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')} failed: ${result.stderr ?? ''}`,
    )
  return result.stdout.trim()
}

export function json<T>(
  command: string,
  args: string[],
  input?: string,
  token?: string,
): T {
  return JSON.parse(run(command, args, input, token)) as T
}

export function remoteBranchExists(
  repository: string,
  branch: string,
  token: string,
): boolean {
  const refs = json<Array<{ ref?: string }>>(
    'gh',
    ['api', `repos/${repository}/git/matching-refs/heads/${branch}`],
    undefined,
    token,
  )
  return refs.some(item => item.ref === `refs/heads/${branch}`)
}
