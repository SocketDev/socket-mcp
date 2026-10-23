import crypto from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { getEnvValue } from '@socketsecurity/lib-stable/env/rewire'
import { safeDeleteSync } from '@socketsecurity/lib-stable/fs/safe'

import { extractZipArchive } from '../artifact/zip.mts'
import { loadSocketWheelhouseConfig } from '../paths.mts'
import { isMainModule } from '../process/is-main-module.mts'
import { runMain } from '../process/main/run.mts'
import type { ScriptMeta } from '../process/main/run.mts'
import { planNativeArtifactFiles } from './native-artifact-files.mts'
import {
  downloadGithubDispatchApi,
  requestGithubDispatchApi,
} from '../registry/github-dispatch.mts'
import { resolveRepoNapiMatrix } from '../registry/napi-matrix.mts'
import { resolveNpmWorkspaceLayout } from '../registry/npm/workspace.mts'
import { rootPath, runCapture } from '../registry/shared.mts'

export const NATIVE_RECEIPT_NAME = 'npm-native-artifacts'
export const NATIVE_RECEIPT_PATH = path.join(
  rootPath,
  '.cache/fleet/native-addons/receipt.json',
)
const MAX_BYTES = 268_435_456

export interface NativeArtifactIdentity {
  id: number
  name: string
  digest: string
}

export interface NativeArtifactReceipt {
  version: 1
  repository: string
  sourceSha: string
  runId: number
  artifacts: NativeArtifactIdentity[]
}

export function validateNativeArtifactSet(
  artifacts: readonly NativeArtifactIdentity[],
  platforms: readonly string[],
): void {
  const expected = new Set(platforms.map(platform => `addons-${platform}`))
  if (
    artifacts.length !== expected.size ||
    new Set(artifacts.map(item => item.id)).size !== expected.size
  ) {
    throw new Error(
      'Native artifacts are incomplete. Where: build receipt. Saw a missing or duplicate target; wanted the complete matrix. Fix: rerun the native build.',
    )
  }
  for (const artifact of artifacts) {
    if (
      !expected.delete(artifact.name) ||
      !Number.isSafeInteger(artifact.id) ||
      artifact.id < 1 ||
      !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest)
    ) {
      throw new Error(
        'Native artifact identity is invalid. Where: build receipt. Saw an unexpected target or digest; wanted one immutable artifact per target. Fix: rerun the native build.',
      )
    }
  }
}

export function validateNativeBuildRun(
  value: unknown,
  repository: string,
  sourceSha: string,
): number {
  const run = value as Record<string, unknown>
  const owner = run['repository'] as Record<string, unknown> | undefined
  const headOwner = run['head_repository'] as
    | Record<string, unknown>
    | undefined
  if (
    run['status'] !== 'completed' ||
    run['conclusion'] !== 'success' ||
    run['event'] !== 'workflow_dispatch' ||
    run['path'] !== '.github/workflows/publish-npm-addons.yml' ||
    run['head_sha'] !== sourceSha ||
    owner?.['full_name'] !== repository ||
    headOwner?.['full_name'] !== repository ||
    !Number.isSafeInteger(run['id']) ||
    Number(run['id']) < 1
  ) {
    throw new Error(
      'Native build is untrusted. Where: GitHub Actions. Saw a failed or unrelated build; wanted a successful native workflow for the exact source SHA. Fix: build this source before staging.',
    )
  }
  return Number(run['id'])
}

async function githubJson(endpoint: string): Promise<unknown> {
  return JSON.parse(
    (await requestGithubDispatchApi(endpoint)).toString('utf8'),
  ) as unknown
}

async function artifactFiles(
  repository: string,
  artifact: NativeArtifactIdentity,
) {
  const metadata = (await githubJson(
    `repos/${repository}/actions/artifacts/${artifact.id}`,
  )) as Record<string, unknown>
  if (
    metadata['expired'] !== false ||
    metadata['name'] !== artifact.name ||
    metadata['digest'] !== artifact.digest
  ) {
    throw new Error(
      'Native artifact metadata changed. Where: GitHub artifact. Saw expired or different bytes; wanted the receipt identity. Fix: rebuild and stage again.',
    )
  }
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'npm-native-'))
  try {
    const archivePath = path.join(scratch, 'artifact.zip')
    await downloadGithubDispatchApi(
      `repos/${repository}/actions/artifacts/${artifact.id}/zip`,
      archivePath,
      MAX_BYTES,
    )
    const archive = readFileSync(archivePath)
    if (`sha256:${crypto.hash('sha256', archive)}` !== artifact.digest) {
      throw new Error(
        'Native artifact digest differs. Where: downloaded archive. Saw unverified bytes; wanted the immutable SHA256. Fix: rebuild and stage again.',
      )
    }
    return extractZipArchive(archive, {
      maxArchiveBytes: MAX_BYTES,
      maxEntries: 4,
      maxEntryBytes: MAX_BYTES,
      maxTotalBytes: MAX_BYTES,
    })
  } finally {
    safeDeleteSync(scratch)
  }
}

async function listArtifacts(
  repository: string,
  runId: number,
): Promise<NativeArtifactIdentity[]> {
  const listing = (await githubJson(
    `repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`,
  )) as { artifacts: NativeArtifactIdentity[]; total_count: number }
  if (
    !Array.isArray(listing.artifacts) ||
    listing.total_count !== listing.artifacts.length
  ) {
    throw new Error(
      'Native artifact listing is incomplete. Where: GitHub Actions. Saw truncated metadata; wanted the complete run. Fix: rebuild with only the expected artifacts.',
    )
  }
  return listing.artifacts.map(({ id, name, digest }) => ({
    __proto__: null,
    id,
    name,
    digest,
  }))
}

async function stageNativeArtifact(
  repository: string,
  artifact: NativeArtifactIdentity,
  runArtifacts: readonly NativeArtifactIdentity[],
  filePlan: ReturnType<typeof planNativeArtifactFiles>,
  destinationRoot: string,
): Promise<void> {
  if (
    !runArtifacts.some(
      item =>
        item.id === artifact.id &&
        item.digest === artifact.digest &&
        item.name === artifact.name,
    )
  ) {
    throw new Error(
      'Native receipt artifact does not belong to the verified build run.',
    )
  }
  const files = await artifactFiles(repository, artifact)
  const platformId = artifact.name.slice('addons-'.length)
  const platformPlan = filePlan.filter(item => item.platformId === platformId)
  if (
    files.length !== platformPlan.length ||
    !platformPlan.every(item =>
      files.some(file => file.name === item.source && file.data.length > 0),
    )
  ) {
    throw new Error(
      'Native artifact payload is incomplete. Where: build artifact. Saw a missing, empty, or unexpected file; wanted exactly the configured nonempty files. Fix: rebuild the native artifact.',
    )
  }
  for (let index = 0, { length } = platformPlan; index < length; index += 1) {
    const item = platformPlan[index]!
    const file = files.find(candidate => candidate.name === item.source)!
    const destination = path.join(destinationRoot, item.destination)
    mkdirSync(path.dirname(destination), { recursive: true })
    writeFileSync(destination, file.data)
  }
}

async function resolveNativeReceipt(
  repository: string,
  sourceSha: string,
  publishRun: string | undefined,
): Promise<NativeArtifactReceipt> {
  let receipt: NativeArtifactReceipt
  if (publishRun) {
    if (!/^[1-9]\d*$/u.test(publishRun)) {
      throw new Error('Invalid original publish run ID.')
    }
    const run = (await githubJson(
      `repos/${repository}/actions/runs/${publishRun}`,
    )) as Record<string, unknown>
    const commit = (await githubJson(
      `repos/${repository}/commits/${sourceSha}`,
    )) as { parents: Array<{ sha: string }> }
    const parent =
      commit.parents.length === 1 ? commit.parents[0]!.sha : undefined
    if (
      run['path'] !== '.github/workflows/publish-npm.yml' ||
      run['event'] !== 'workflow_dispatch' ||
      run['conclusion'] !== 'success'
    ) {
      throw new Error(
        'Native scan source does not match the original publish source.',
      )
    }
    const artifacts = await listArtifacts(repository, Number(publishRun))
    const matches = artifacts.filter(item => item.name === NATIVE_RECEIPT_NAME)
    if (matches.length !== 1) {
      throw new Error(
        'Expected one native artifact receipt in the original publish run.',
      )
    }
    const files = await artifactFiles(repository, matches[0]!)
    if (files.length !== 1 || files[0]!.name !== 'receipt.json') {
      throw new Error(
        'Native artifact receipt archive has an unexpected file set.',
      )
    }
    receipt = JSON.parse(
      files[0]!.data.toString('utf8'),
    ) as NativeArtifactReceipt
    if (
      receipt.version !== 1 ||
      receipt.repository !== repository ||
      (receipt.sourceSha !== sourceSha && receipt.sourceSha !== parent)
    ) {
      throw new Error(
        'Native artifact receipt does not match the original publish run.',
      )
    }
  } else {
    const listing = (await githubJson(
      `repos/${repository}/actions/workflows/publish-npm-addons.yml/runs?head_sha=${sourceSha}&event=workflow_dispatch&status=success&per_page=100`,
    )) as { workflow_runs: Array<Record<string, unknown>> }
    const run = listing.workflow_runs.find(
      candidate => candidate['head_sha'] === sourceSha,
    )
    if (!run) {
      throw new Error(
        'No successful native build exists for this source SHA. Complete the native workflow before publishing.',
      )
    }
    const runId = validateNativeBuildRun(run, repository, sourceSha)
    receipt = {
      version: 1,
      repository,
      sourceSha,
      runId,
      artifacts: await listArtifacts(repository, runId),
    }
  }
  return receipt
}

export async function main(): Promise<void> {
  const matrix = resolveRepoNapiMatrix()
  if (!matrix.include.length) {
    return
  }
  const owners = resolveNpmWorkspaceLayout(rootPath).packages.filter(
    pkg => pkg.generatorPath,
  )
  if (owners.length !== 1) {
    throw new Error(
      'Native artifact staging requires exactly one package generator owner.',
    )
  }
  const owner = owners[0]!
  const repository = getEnvValue('GITHUB_REPOSITORY') ?? ''
  const sourceSha = (
    await runCapture('git', ['rev-parse', 'HEAD'], rootPath)
  ).stdout.trim()
  if (
    !/^[\w.-]+\/[\w.-]+$/u.test(repository) ||
    !/^[a-f0-9]{40}$/u.test(sourceSha)
  ) {
    throw new Error(
      'Native artifact source is missing. Run inside the trusted publish workflow.',
    )
  }
  const publishRun = getEnvValue('NATIVE_PUBLISH_RUN_ID')
  const receipt = await resolveNativeReceipt(repository, sourceSha, publishRun)
  const config = loadSocketWheelhouseConfig()?.value
  const napi = (config?.['napi'] ?? {}) as {
    artifactFiles?: Readonly<Record<string, string>> | undefined
  }
  const filePlan = planNativeArtifactFiles(napi.artifactFiles, matrix.include)
  validateNativeArtifactSet(
    receipt.artifacts,
    matrix.include.map(item => item.platformId),
  )
  validateNativeBuildRun(
    await githubJson(`repos/${repository}/actions/runs/${receipt.runId}`),
    repository,
    receipt.sourceSha,
  )
  const runArtifacts = await listArtifacts(repository, receipt.runId)
  for (const artifact of receipt.artifacts) {
    await stageNativeArtifact(
      repository,
      artifact,
      runArtifacts,
      filePlan,
      owner.dir,
    )
  }
  mkdirSync(path.dirname(NATIVE_RECEIPT_PATH), { recursive: true })
  writeFileSync(NATIVE_RECEIPT_PATH, `${JSON.stringify(receipt)}\n`)
  if (publishRun) {
    const generated = await runCapture('node', [owner.generatorPath!], rootPath)
    if (generated.code !== 0) {
      throw new Error(
        'Native package generation failed before scan. Inspect the package generator.',
      )
    }
  }
}

const SCRIPT_META: ScriptMeta = {
  describe: 'verifies and stages source-bound native npm artifacts',
  help: 'Usage: native-artifacts.mts [--json]',
  json: 'result',
}

if (isMainModule(import.meta.url)) {
  runMain(() => main(), SCRIPT_META)
}
