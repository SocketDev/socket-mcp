import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { isMainModule, runMain } from '../cli.mts'
import { matchesReleasePolicy, readReleasePolicy } from './release-policy.mts'

const uuid =
  /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/iu

export function validateStage(
  value: unknown,
  id: string,
  name: string,
  policy = readReleasePolicy(),
): string {
  if (!value || typeof value !== 'object')
    throw new Error('npm returned an invalid stage.')
  const v = value as Record<string, unknown>
  const stageId = v['id']
  const pkg = v['packageName']
  if (
    stageId !== id ||
    pkg !== name ||
    typeof v['version'] !== 'string' ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u.test(
      v['version'],
    )
  )
    throw new Error(
      'npm stage ID, package, or version did not match the requested stage and repository manifest.',
    )
  if (!matchesReleasePolicy(v['version'], policy))
    throw new Error(
      policy.mode === 'prerelease-only'
        ? `npm stage version must stay on the ${policy.versionHint}-${policy.identifier}.N prerelease track.`
        : 'Stable release policy does not allow a prerelease stage.',
    )
  return v['version']
}

export function run(command: string, args: string[], inherit = false): string {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  })
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')} failed${result.stderr ? `: ${result.stderr}` : '.'}`,
    )
  return result.stdout?.trim() ?? ''
}

export async function approveNpmStage(
  id: string,
  name: string,
  command = run,
  wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<void> {
  if (!uuid.test(id)) throw new Error('Invalid npm stage UUID.')
  const policy = readReleasePolicy()
  const deadline = Date.now() + 30 * 60_000
  let delay = 2_000
  let version = ''
  let status = ''
  while (true) {
    const raw = command('pnpm', [
      'stage',
      'view',
      id,
      '--json',
      '--registry=https://registry.npmjs.org',
    ])
    let record: unknown
    try {
      record = JSON.parse(raw) as unknown
    } catch {
      throw new Error('npm stage view did not return JSON.')
    }
    status = String((record as Record<string, unknown>)?.['status'])
    version = validateStage(record, id, name, policy)
    if (status === 'staged' || status === 'published') break
    if (status === 'blocked' || status === 'deleted')
      throw new Error(
        `npm stage is ${status}; v${version} is burned and will not be reused. Run pnpm run publish:npm to prepare the next version after confirming this stage cannot be approved.`,
      )
    if (status !== 'validating')
      throw new Error(`npm stage is ${status}; approval stopped.`)
    if (Date.now() >= deadline)
      throw new Error(
        'Timed out waiting for npm validation; the stage remains available to retry.',
      )
    await wait(Math.min(delay, deadline - Date.now()))
    delay = Math.min(delay * 2, 30_000)
  }
  const context = JSON.parse(
    command('gh', ['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef']),
  ) as {
    nameWithOwner?: string
    defaultBranchRef?: { name?: string }
  }
  const repository = context.nameWithOwner
  const branch = context.defaultBranchRef?.name
  if (
    !repository ||
    !/^[^/\s]+\/[^/\s]+$/u.test(repository) ||
    !branch ||
    !/^[A-Za-z0-9._/-]+$/u.test(branch) ||
    branch.startsWith('-')
  )
    throw new Error('GitHub returned an invalid repository or default branch.')
  const tag = `v${version}`
  const tagRef = encodeURIComponent(`refs/tags/${tag}`)
  const manifestResponse = JSON.parse(
    command('gh', [
      'api',
      `repos/${repository}/contents/package.json?ref=${tagRef}`,
    ]),
  ) as { encoding?: string; content?: string }
  if (manifestResponse.encoding !== 'base64' || !manifestResponse.content)
    throw new Error(
      `GitHub could not read package.json at existing tag ${tag}.`,
    )
  const taggedManifest = JSON.parse(
    Buffer.from(manifestResponse.content, 'base64').toString('utf8'),
  ) as { name?: string; version?: string }
  if (taggedManifest.name !== name || taggedManifest.version !== version)
    throw new Error(`Existing tag ${tag} does not contain ${name}@${version}.`)
  if (status === 'staged')
    command(
      'pnpm',
      ['stage', 'approve', id, '--registry=https://registry.npmjs.org'],
      true,
    )
  else
    process.stdout.write(
      `npm stage ${id} is already published; retrying GitHub release finalization.\n`,
    )
  try {
    command(
      'gh',
      [
        'workflow',
        'run',
        'release-github.yml',
        '--repo',
        repository,
        '--ref',
        branch,
        '-f',
        `tag=${tag}`,
      ],
      true,
    )
  } catch (error) {
    process.stderr.write(
      `${String(error)}\nnpm stage ${id} is approved; retry release finalization with: gh workflow run release-github.yml --repo ${repository} --ref ${branch} -f tag=${tag}\n`,
    )
    throw new Error('Release dispatch failed after npm approval.')
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { positionals } = parseArgs({
    args,
    options: {},
    strict: true,
    allowPositionals: true,
  })
  const id = positionals[0]
  if (!id || positionals.length !== 1 || !uuid.test(id))
    throw new Error('Usage: pnpm run approve:npm <stage-id>')
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
    name?: string
  }
  if (!manifest.name)
    throw new Error('Repository package.json has no package name.')
  await approveNpmStage(id, manifest.name)
}

if (isMainModule(import.meta.url))
  runMain(main, {
    describe:
      'Approves a validated npm stage and dispatches GitHub release finalization.',
    help: 'Usage: pnpm run approve:npm <stage-id>',
  })
