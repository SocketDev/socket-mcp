import { parseArgs } from 'node:util'
import { getScriptArgs } from '../../process/script-output.mts'
import { runMain } from '../../process/main/run.mts'
import { isMainModule } from '../../process/is-main-module.mts'
import {
  abandonNpmRelease,
  npmReleaseRecordStore,
  npmReleaseSourceSha,
} from './npm.mts'
import {
  listStagedPackages,
  npmScratchCwd,
} from '../../registry/npm/shared.mts'
import { isPublishedVersionChecked } from '../../registry/npm/registry.mts'
import { resolveNpmStageCommand } from '../../registry/npm/stage-command.mts'
import { runNativeNpmOperation } from '../../registry/npm/settings/trust.mts'
import { resolveNpmWorkspaceLayout } from '../../registry/npm/workspace.mts'
import { rootPath } from '../../registry/shared.mts'
import type { ScriptMeta } from '../../process/main/run.mts'
import { createReleaseRecordStore } from './github.mts'
import { recoverReleaseLedgerInitialization } from './recovery.mts'

export async function runNpmReleaseRecord(
  options: { argv?: string[] | undefined } = {},
): Promise<{ exitCode: number; data: unknown }> {
  const config = { __proto__: null, ...options }
  const { argv = getScriptArgs() } = config
  return processNpmReleaseRecord(argv)
}

async function processNpmReleaseRecord(
  argv: string[],
): Promise<{ exitCode: number; data: unknown }> {
  const { values } = parseNpmReleaseRecordArgs(argv)
  const recoveryConfig = parseLedgerRecoveryConfig(values)
  if (recoveryConfig) {
    const data = await recoverReleaseLedgerInitialization(recoveryConfig)
    return { exitCode: 0, data }
  }
  if (values.setup) {
    return setupNpmReleaseRecord(values)
  }
  if (Boolean(values.name) === values['all-packages'] || !values.version) {
    throw new Error(
      'Release record requires exactly one of --name or --all-packages, plus --version.',
    )
  }
  if (!values.abandon && (values['all-packages'] || values['record-only'])) {
    throw new Error('--all-packages and --record-only require --abandon.')
  }
  const layout = resolveNpmWorkspaceLayout(rootPath)
  const ownedNames =
    layout.kind === 'multi'
      ? layout.packages.map(pkg => pkg.name)
      : [layout.subject?.name]
  const names = values['all-packages']
    ? ownedNames.filter((name): name is string => typeof name === 'string')
    : [values.name!]
  if (!names.length || names.some(name => !ownedNames.includes(name))) {
    throw new Error(
      'Release record package is not published by this repository.',
    )
  }
  if (!values.abandon) {
    const existing = await (
      await npmReleaseRecordStore()
    ).read({
      registry: 'npm',
      name: names[0]!,
      version: values.version,
    })
    return { exitCode: 0, data: existing }
  }
  return abandonNpmReleaseRecord(values, names, values.version)
}

async function abandonNpmReleaseRecord(
  values: ReturnType<typeof parseNpmReleaseRecordArgs>['values'],
  names: string[],
  version: string,
): Promise<{ exitCode: number; data: unknown }> {
  if (!values.reason?.trim()) {
    throw new Error('Permanent abandonment requires --reason.')
  }
  const store = await npmReleaseRecordStore()
  const identities: Array<{
    name: string
    registry: 'npm'
    sourceSha: string
    version: string
  }> = []
  let resolvedSourceSha: string | undefined
  for (let index = 0, { length } = names; index < length; index += 1) {
    const name = names[index]!
    const key = { registry: 'npm' as const, name, version }
    const existing = await store.read(key)
    if (existing?.record.sourceSha) {
      identities.push({ ...key, sourceSha: existing.record.sourceSha })
    } else {
      resolvedSourceSha ??= await npmReleaseSourceSha(version)
      identities.push({ ...key, sourceSha: resolvedSourceSha })
    }
  }
  for (let index = 0, { length } = identities; index < length; index += 1) {
    const identity = identities[index]!
    if (await isPublishedVersionChecked(identity.name, identity.version)) {
      throw new Error(
        `A public npm release cannot be abandoned or reused: ${identity.name}@${identity.version}.`,
      )
    }
  }
  if (values['dry-run']) {
    return {
      exitCode: 0,
      data: { dryRun: true, operation: 'abandon', identities },
    }
  }
  const records: Array<Awaited<ReturnType<typeof abandonNpmRelease>>> = []
  for (let index = 0, { length } = identities; index < length; index += 1) {
    const identity = identities[index]!
    records.push(await abandonNpmRelease(identity, values.reason))
  }
  if (values['record-only']) {
    return { exitCode: 0, data: { records } }
  }
  const cleanup: Array<Awaited<ReturnType<typeof rejectNpmReleaseStages>>> = []
  for (let index = 0; index < identities.length; index += 1) {
    const identity = identities[index]!
    cleanup.push(
      await rejectNpmReleaseStages(
        identity.name,
        identity.version,
        records[index]!,
      ),
    )
  }
  if (cleanup.length === 1) {
    return cleanup[0]!
  }
  return {
    exitCode: cleanup.some(result => result.exitCode !== 0) ? 1 : 0,
    data: { records, cleanup },
  }
}

function parseLedgerRecoveryConfig(
  values: ReturnType<typeof parseNpmReleaseRecordArgs>['values'],
) {
  const recoveryOptions = [
    values['ruleset-id'],
    values['failed-rule-suite-id'],
    values['failure-log'],
    values['legacy-source'],
  ]
  if (
    values['recover-initialization'] ||
    recoveryOptions.some(value => value !== undefined)
  ) {
    if (
      !values.setup ||
      !values['recover-initialization'] ||
      recoveryOptions.some(value => !value) ||
      values.abandon ||
      values['all-packages'] ||
      values['record-only'] ||
      values.name ||
      values.version ||
      values.reason
    ) {
      throw new Error(
        'Initialization recovery requires --setup, both IDs, --failure-log, and --legacy-source without release operations.',
      )
    }
    const rulesetId = Number(values['ruleset-id'])
    const failedSuiteId = Number(values['failed-rule-suite-id'])
    // Require positive decimal IDs without whitespace or a sign.
    if (
      ![values['ruleset-id'], values['failed-rule-suite-id']].every(value =>
        /^[1-9][0-9]*$/u.test(value!),
      ) ||
      ![rulesetId, failedSuiteId].every(Number.isSafeInteger)
    ) {
      throw new Error(
        'Initialization recovery IDs must be positive safe integers.',
      )
    }
    return {
      __proto__: null,
      rulesetId,
      failedSuiteId,
      failureLog: values['failure-log']!,
      legacySource: values['legacy-source']!,
      dryRun: values['dry-run'],
    }
  }
  return undefined
}

async function setupNpmReleaseRecord(
  values: ReturnType<typeof parseNpmReleaseRecordArgs>['values'],
): Promise<{ exitCode: number; data: unknown }> {
  if (
    values.abandon ||
    values['all-packages'] ||
    values['record-only'] ||
    values.name ||
    values.version ||
    values.reason
  ) {
    throw new Error(
      'Release ledger setup cannot be combined with a release operation.',
    )
  }
  if (values['dry-run']) {
    return { exitCode: 0, data: { dryRun: true, operation: 'setup' } }
  }
  await createReleaseRecordStore({ setup: true })
  return { exitCode: 0, data: { configured: true } }
}

async function rejectNpmReleaseStages(
  name: string,
  version: string,
  record: Awaited<ReturnType<typeof abandonNpmRelease>>,
): Promise<{ exitCode: number; data: unknown }> {
  const stages = (await listStagedPackages()).filter(
    entry => entry.name === name && entry.version === version,
  )
  const command = resolveNpmStageCommand()
  const failures: string[] = []
  for (let index = 0, { length } = stages; index < length; index += 1) {
    const stage = stages[index]!
    if (!stage.stageId) {
      throw new Error(
        'Matching stage lacks its registry identity; abandonment is recorded but cleanup remains pending.',
      )
    }
    const result = await runNativeNpmOperation(
      command.command,
      [...command.argsPrefix, 'stage', 'reject', stage.stageId],
      npmScratchCwd(),
    )
    if (result.code !== 0) {
      failures.push(stage.stageId)
    }
  }
  const remaining = (await listStagedPackages()).filter(
    entry => entry.name === name && entry.version === version,
  )
  return {
    exitCode: remaining.length ? 1 : 0,
    data: {
      record,
      remaining: remaining.map(entry => entry.stageId),
      failedAttempts: failures,
    },
  }
}

function parseNpmReleaseRecordArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    strict: true,
    options: {
      name: { type: 'string' },
      version: { type: 'string' },
      reason: { type: 'string' },
      abandon: { type: 'boolean', default: false },
      'record-only': { type: 'boolean', default: false },
      'all-packages': { type: 'boolean', default: false },
      setup: { type: 'boolean', default: false },
      'recover-initialization': { type: 'boolean', default: false },
      'ruleset-id': { type: 'string' },
      'failed-rule-suite-id': { type: 'string' },
      'failure-log': { type: 'string' },
      'legacy-source': { type: 'string' },
      json: { type: 'boolean' },
      'dry-run': { type: 'boolean', default: false },
    },
  })
}

const SCRIPT_META: ScriptMeta = {
  describe:
    'read a durable npm release record or permanently abandon a version before stage cleanup',
  help: 'Usage: pnpm run npm:release-record --setup [--recover-initialization --ruleset-id ID --failed-rule-suite-id ID --failure-log FILE --legacy-source FILE] | (--name <package> | --all-packages) --version <version> [--abandon --reason <reason> [--record-only]] [--dry-run] [--json]',
  json: 'result',
}

if (isMainModule(import.meta.url)) {
  runMain(() => runNpmReleaseRecord(), SCRIPT_META)
}
