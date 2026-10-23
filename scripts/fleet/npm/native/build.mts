import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { getEnvValue } from '@socketsecurity/lib-stable/env/rewire'
import { safeDeleteSync } from '@socketsecurity/lib-stable/fs/safe'

import { planNativeArtifactFiles } from '../native-artifact-files.mts'
import { isMainModule } from '../../process/is-main-module.mts'
import { runMain } from '../../process/main/run.mts'
import type { ScriptMeta } from '../../process/main/run.mts'
import { loadSocketWheelhouseConfig } from '../../paths.mts'
import { resolveRepoNapiMatrix } from '../../registry/napi-matrix.mts'
import { rootPath, runInherit } from '../../registry/shared.mts'
import { isNapiTarget } from '../../util/napi-targets.mts'
import type { NapiNativeTarget } from '../../util/napi-targets.mts'
import type { NapiMatrixEntry } from '../../registry/napi-matrix.mts'

const BUILD_SCRIPT_PATTERN =
  /^scripts\/repo\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.mts$/u

export interface NativeBuildPlan {
  target: NapiNativeTarget
  platformId: string
  scriptPath: string
  outputDirectory: string
  outputFiles: string[]
}

export function resolveNativeBuildPlan(request: {
  config: Record<string, unknown> | undefined
  matrix: readonly NapiMatrixEntry[]
  target: string
  repoRoot?: string | undefined
}): NativeBuildPlan {
  const { config, matrix, target, repoRoot = rootPath } = request
  if (!isNapiTarget(target) || target === 'wasm32-wasi') {
    throw new Error(
      'Native target is invalid. Where: NAPI_TARGET. Saw an unknown or wasm target; wanted a native napi target in the configured matrix. Fix: use a target emitted by napi-matrix.mts.',
    )
  }
  const entry = matrix.find(item => item.target === target)
  if (!entry || entry.customBuild !== true) {
    throw new Error(
      'Native target is not configured for a custom build. Where: napi matrix. Saw a missing or default producer target; wanted a configured custom producer target. Fix: declare napi.buildScript and napi.platforms.',
    )
  }
  const { buildScript, artifactFiles } = resolveNativeBuildConfig(config)
  const filePlan = planNativeArtifactFiles(artifactFiles, [entry])
  const canonicalScript = resolveNativeBuildScript(repoRoot, buildScript)
  return {
    target,
    platformId: entry.platformId,
    scriptPath: canonicalScript,
    outputDirectory: path.join(
      repoRoot,
      '.cache',
      'fleet',
      'native-addons',
      'build',
      entry.platformId,
    ),
    outputFiles: filePlan.map(item => item.source),
  }
}

function resolveNativeBuildConfig(
  config: Record<string, unknown> | undefined,
): { buildScript: string; artifactFiles: Record<string, string> } {
  const napi = config?.['napi']
  if (typeof napi !== 'object' || napi === null || Array.isArray(napi)) {
    throw new Error(
      'Native build config is missing. Where: socket-wheelhouse.json. Saw no napi object; wanted napi.buildScript and napi.artifactFiles. Fix: add the custom producer config.',
    )
  }
  const napiConfig = napi as Record<string, unknown>
  const buildScript = napiConfig['buildScript']
  if (
    typeof buildScript !== 'string' ||
    !BUILD_SCRIPT_PATTERN.test(buildScript)
  ) {
    throw new Error(
      'Native build script path is invalid. Where: napi.buildScript. Saw a missing or unsafe path; wanted a scripts/repo/*.mts file. Fix: set a safe repo-relative script path.',
    )
  }
  const artifactFiles = napiConfig['artifactFiles']
  if (
    typeof artifactFiles !== 'object' ||
    artifactFiles === null ||
    Array.isArray(artifactFiles) ||
    Object.keys(artifactFiles).length === 0
  ) {
    throw new Error(
      'Native artifact names are missing. Where: napi.artifactFiles. Saw an empty custom producer file map; wanted every expected .node basename. Fix: declare the output files.',
    )
  }
  return {
    buildScript,
    artifactFiles: artifactFiles as Record<string, string>,
  }
}

function resolveNativeBuildScript(
  repoRoot: string,
  buildScript: string,
): string {
  const scriptPath = path.resolve(repoRoot, ...buildScript.split('/'))
  const repoRelative = path.relative(repoRoot, scriptPath)
  if (
    repoRelative === '..' ||
    repoRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(repoRelative) ||
    !existsSync(scriptPath)
  ) {
    throw new Error(
      'Native build script is unavailable. Where: napi.buildScript. Saw a missing or out-of-scope file; wanted an existing file under scripts/repo. Fix: add the producer script inside scripts/repo.',
    )
  }
  const canonicalRepo = realpathSync(repoRoot)
  const scriptRoot = realpathSync(path.join(repoRoot, 'scripts/repo'))
  const canonicalScript = realpathSync(scriptPath)
  const scriptRootRelative = path.relative(canonicalRepo, scriptRoot)
  const scriptRelative = path.relative(scriptRoot, canonicalScript)
  if (
    !existsSync(canonicalScript) ||
    !statSync(canonicalScript).isFile() ||
    scriptRootRelative === '' ||
    scriptRootRelative === '..' ||
    scriptRootRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(scriptRootRelative) ||
    scriptRelative === '' ||
    scriptRelative === '..' ||
    scriptRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(scriptRelative)
  ) {
    throw new Error(
      'Native build script is unavailable. Where: napi.buildScript. Saw a missing or out-of-scope file; wanted an existing file under scripts/repo. Fix: add the producer script inside scripts/repo.',
    )
  }
  return canonicalScript
}

export function validateNativeBuildOutputs(plan: NativeBuildPlan): void {
  const entries = readdirSync(plan.outputDirectory, { withFileTypes: true })
  const expected = new Set(plan.outputFiles)
  if (entries.length !== expected.size) {
    throw new Error(
      'Native build output is incomplete. Where: fixed output directory. Saw an unexpected file count; wanted exactly the configured artifact names. Fix: update the producer output.',
    )
  }
  for (const entry of entries) {
    const outputPath = path.join(plan.outputDirectory, entry.name)
    if (
      !expected.delete(entry.name) ||
      !entry.isFile() ||
      statSync(outputPath).size === 0
    ) {
      throw new Error(
        'Native build output is invalid. Where: fixed output directory. Saw an unexpected, non-file, or empty entry; wanted each configured nonempty .node file. Fix: update the producer output.',
      )
    }
  }
}

export async function main(): Promise<void> {
  const config = loadConfig()
  const matrix = resolveRepoNapiMatrix()
  const plan = resolveNativeBuildPlan({
    config,
    matrix: matrix.include,
    target: getEnvValue('NAPI_TARGET') ?? '',
  })
  safeDeleteSync(plan.outputDirectory)
  mkdirSync(plan.outputDirectory, { recursive: true })
  const code = await runNativeProducer(plan)
  if (code !== 0) {
    throw new Error(
      `Native producer failed. Where: ${plan.scriptPath}. Saw exit code ${code}; wanted exit code 0. Fix: repair the configured producer script.`,
    )
  }
  validateNativeBuildOutputs(plan)
}

export async function runNativeProducer(
  plan: NativeBuildPlan,
): Promise<number> {
  return await runInherit(
    process.execPath,
    [plan.scriptPath, plan.target, plan.outputDirectory],
    rootPath,
    { MBX_REMOTE_URL: '' },
  )
}

function loadConfig(): Record<string, unknown> | undefined {
  return loadSocketWheelhouseConfig(rootPath)?.value
}

const SCRIPT_META: ScriptMeta = {
  describe:
    'runs a configured napi native producer into a fixed output directory',
  help: 'Usage: native/build.mts [--json]',
  json: 'result',
}

if (isMainModule(import.meta.url)) {
  runMain(() => main(), SCRIPT_META)
}
