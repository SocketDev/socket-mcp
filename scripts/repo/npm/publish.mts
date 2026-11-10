import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { isMainModule, runMain } from '../cli.mts'
import { validateNpmRelease } from './validate.mts'
import { verifyNpmTarball } from './pack.mts'
import type { NpmPayloadManifest } from './pack.mts'

export function parseNpmStageId(
  output: string,
  name: string,
  version: string,
): string {
  let value: unknown
  try {
    value = JSON.parse(output) as unknown
  } catch {
    throw new Error('pnpm stage publish --json returned invalid JSON.')
  }
  const summary = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? Object.values(value)
      : []
  const matches = summary.filter(
    item =>
      item &&
      typeof item === 'object' &&
      (item as Record<string, unknown>)['name'] === name &&
      (item as Record<string, unknown>)['version'] === version,
  )
  const item = matches[0] as Record<string, unknown> | undefined
  const id = item?.['stageId']
  if (
    matches.length !== 1 ||
    typeof id !== 'string' ||
    !/^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/iu.test(
      id,
    )
  )
    throw new Error(`Expected one npm stage identity for ${name}@${version}.`)
  return id
}

export function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): string {
  const result = spawnSync(command, args, {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
  })
  const output = result.stdout ?? ''
  process.stdout.write(output)
  process.stderr.write(result.stderr ?? '')
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')} failed with status ${result.status}.`,
    )
  return output
}

export async function runNpmStagePublish(
  env = process.env,
): Promise<{ name: string; version: string; tag: string; stageId: string }> {
  const manifest = JSON.parse(
    readFileSync('package.json', 'utf8'),
  ) as NpmPayloadManifest
  if (env['GITHUB_ACTIONS'] !== 'true' || !env['GITHUB_RUN_ID'])
    throw new Error(
      'Staging is available only inside the npm publish workflow.',
    )
  if (env['GITHUB_RUN_ATTEMPT'] !== '1')
    throw new Error(
      'Recover the original npm stage; workflow reruns cannot upload a version again.',
    )
  if (
    !env['ACTIONS_ID_TOKEN_REQUEST_URL'] ||
    !env['ACTIONS_ID_TOKEN_REQUEST_TOKEN']
  )
    throw new Error('The publish job requires an OIDC token.')
  if (!env['GITHUB_SHA'] || !/^[a-f\d]{40}$/u.test(env['GITHUB_SHA']))
    throw new Error('The publish job must identify its source commit.')
  for (const key of ['NODE_AUTH_TOKEN', 'NPM_AUTH_TOKEN', 'NPM_TOKEN'])
    if (env[key])
      throw new Error(
        `${key} is set; OIDC publishing forbids long-lived npm tokens.`,
      )
  const tag = env['DIST_TAG'] ?? 'latest'
  validateNpmRelease(manifest, {
    defaultBranch: env['DEFAULT_BRANCH'],
    ref: env['GITHUB_REF'],
    distTag: tag,
  })
  const registry = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(manifest.name)}`,
    {
      signal: AbortSignal.timeout(30_000),
      headers: { 'cache-control': 'no-cache' },
    },
  )
  if (registry.status === 200) {
    const data = (await registry.json()) as {
      versions?: Record<string, unknown>
    }
    if (Object.hasOwn(data.versions ?? {}, manifest.version))
      throw new Error(
        `${manifest.name}@${manifest.version} is already public; versions are never reused.`,
      )
  } else if (registry.status !== 404)
    throw new Error(`npm registry lookup failed with HTTP ${registry.status}.`)
  const directory = mkdtempSync(path.join(tmpdir(), 'npm-stage-'))
  try {
    run(
      'pnpm',
      ['pack', '--config.ignore-scripts=true', '--pack-destination', directory],
      env,
    )
    const filename = `${manifest.name.replace(/^@/u, '').replace('/', '-')}-${manifest.version}.tgz`
    const tarball = path.join(directory, filename)
    verifyNpmTarball(tarball, manifest)
    const output = run(
      'pnpm',
      [
        'stage',
        'publish',
        tarball,
        '--access',
        'public',
        '--tag',
        tag,
        '--no-git-checks',
        '--ignore-scripts',
        '--provenance',
        '--registry=https://registry.npmjs.org',
        '--json',
      ],
      env,
    )
    if (/ERR_PNPM_AUTH_TOKEN_EXCHANGE|Skipped OIDC/u.test(output))
      throw new Error(
        'npm OIDC token exchange failed; check trusted publisher configuration.',
      )
    const stageId = parseNpmStageId(output, manifest.name, manifest.version)
    const summary = env['GITHUB_STEP_SUMMARY']
    if (summary)
      writeFileSync(
        summary,
        `## npm stage\n\n- Package: \`${manifest.name}\`\n- Version: \`${manifest.version}\`\n- npm dist-tag: \`${tag}\`\n- Git tag: \`v${manifest.version}\`\n- Stage ID: \`${stageId}\`\n\nApprove locally with \`pnpm run approve:npm ${stageId}\`.\n`,
        { flag: 'a' },
      )
    process.stdout.write(
      `Stage ready: ${manifest.name}@${manifest.version}, tag ${tag}, ID ${stageId}. Approve with pnpm run approve:npm ${stageId}.\n`,
    )
    return { name: manifest.name, version: manifest.version, tag, stageId }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

if (isMainModule(import.meta.url))
  runMain(
    async () => {
      await runNpmStagePublish()
    },
    {
      describe:
        'Builds once, validates, and stages the npm package with provenance.',
      help: 'Usage: node scripts/repo/npm/publish.mts (inside the publish workflow)',
    },
  )
