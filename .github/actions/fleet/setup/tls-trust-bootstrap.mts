/**
 * @file Create and validate the filtered CA inputs used by setup action steps.
 */

import crypto from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { isMainModule } from '../../../../scripts/fleet/process/is-main-module.mts'
import { errorMessage } from '@socketsecurity/lib-stable/errors/message'
import {
  filterTlsCertificates,
  inspectTlsEnvironment,
} from '../../../../scripts/fleet/process/tls-policy.mts'

import {
  readTlsBootstrapCaFile,
  validateTlsBootstrapSources,
} from './tls-trust-files.mts'
import type { TlsBootstrapCaSource } from './tls-trust-files.mts'
import {
  captureTlsPlatformEnvironment,
  readTlsPlatformRoots,
} from '../../../../scripts/fleet/process/tls-platform-roots.mts'
import {
  resolveSfwTlsOverlay,
  sfwTlsRuntimeDirectoryRoot,
  validateSfwTlsRuntimeMarkerPair,
  sfwTlsBashEnvContents,
  sfwTlsEnvironmentLines,
} from './tls-trust-sfw-overlay.mts'
import {
  runtimeTlsTrustReady,
  TLS_RUNTIME_DIRECTORY_KEY,
  TLS_RUNTIME_CA_KEY,
} from '../../../../scripts/fleet/setup/tls-trust-runtime-bundles.mts'
import {
  getDefaultSfwCaCertificatePath,
  TLS_CA_SOURCE_KEYS,
  getTlsTrustBashEnvPath,
  getTlsTrustBundlePath,
  getTlsTrustDisabledCaDirectoryPath,
  getTlsTrustHelperPath,
  getTlsTrustRootPath,
  getTlsTrustStatePath,
} from '../../../../scripts/fleet/paths/tls-trust.mts'
import {
  ensureTlsTrustDisabledCaDirectory,
  isTlsTrustDisabledCaDirectorySafe,
} from '../../../../scripts/fleet/setup/tls-trust-disabled-ca-directory.mts'
import { hasPrivateTlsPermissions } from '../../../../scripts/fleet/setup/tls-trust-permissions.mts'

const CA_KEYS = TLS_CA_SOURCE_KEYS

type State = {
  bundlePaths: Record<string, string>
  emptyDirectoryPath: string
  sources: TlsBootstrapCaSource[]
  version: 1
}

function rootDirectory(): string {
  return getTlsTrustRootPath(process.env['RUNNER_TEMP'] || os.tmpdir())
}

function bashEnvPath(): string {
  return getTlsTrustBashEnvPath(rootDirectory())
}

function digest(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

async function writePrivate(file: string, contents: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}`
  await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 })
  try {
    await chmod(temporary, 0o600)
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

function appendNodeOption(value: string | undefined): string {
  const options = value?.trim().split(/\s+/).filter(Boolean) ?? []
  if (!options.includes('--use-openssl-ca')) {
    options.push('--use-openssl-ca')
  }
  return options.join(' ')
}

async function buildBundles(): Promise<State> {
  const directory = rootDirectory()
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const emptyDirectoryPath = getTlsTrustDisabledCaDirectoryPath(directory)
  await ensureTlsTrustDisabledCaDirectory(emptyDirectoryPath)
  for (const key of ['SSL_CERT_DIR', 'GIT_SSL_CAPATH']) {
    const directoryOverride = process.env[key]
    if (directoryOverride && directoryOverride !== emptyDirectoryPath) {
      throw new Error(
        `${key} points to an unmanaged CA directory; clear it or use the managed disabled CA directory.`,
      )
    }
  }

  const sources: TlsBootstrapCaSource[] = []
  const rejected: string[] = []
  const sfwPath =
    process.env['SFW_CA_CERT_PATH'] ??
    getDefaultSfwCaCertificatePath(os.homedir())
  const sfwBody = await readTlsBootstrapCaFile(
    sfwPath,
    !process.env['SFW_CA_CERT_PATH'],
  )
  const sfwFiltered = filterTlsCertificates(sfwBody ?? '', {
    requireNonEmpty: false,
  })
  rejected.push(...sfwFiltered.rejectedFingerprints)
  sources.push({
    key: 'SFW_CA_CERT_PATH',
    path: sfwPath,
    sha256: sfwBody === undefined ? 'missing' : digest(sfwBody),
  })

  const bundlePaths: Record<string, string> = Object.create(null)
  const bundles: Record<string, string> = Object.create(null)
  const combine = (name: string, sourcePem: string): void => {
    const filtered = filterTlsCertificates(
      [sourcePem, sfwFiltered.pem].filter(Boolean).join('\n'),
    )
    bundles[name] = filtered.pem
    rejected.push(...filtered.rejectedFingerprints)
  }
  const sslFile = process.env['SSL_CERT_FILE']
  if (sslFile) {
    const body = await readTlsBootstrapCaFile(sslFile)
    const filtered = filterTlsCertificates(body!)
    sources.push({ key: 'SSL_CERT_FILE', path: sslFile, sha256: digest(body!) })
    rejected.push(...filtered.rejectedFingerprints)
    combine('SSL_CERT_FILE', filtered.pem)
  } else {
    const platformPem: string[] = []
    for (const kind of ['bundled', 'system'] as const) {
      const filtered = filterTlsCertificates(await readTlsPlatformRoots(kind), {
        requireNonEmpty: false,
        skipNonCa: true,
      })
      platformPem.push(filtered.pem)
      rejected.push(...filtered.rejectedFingerprints)
      sources.push({
        key: `node-${kind}`,
        path: '',
        sha256: digest(filtered.pem),
        ...(kind === 'system'
          ? { environment: captureTlsPlatformEnvironment(process.env) }
          : {}),
      })
    }
    combine('SSL_CERT_FILE', platformPem.filter(Boolean).join('\n'))
  }
  bundlePaths['SSL_CERT_FILE'] = getTlsTrustBundlePath(
    directory,
    'SSL_CERT_FILE',
    { sslCertFileName: 'ssl-cert-file.pem' },
  )

  for (const key of CA_KEYS.slice(1)) {
    const sourcePath = process.env[key]
    if (!sourcePath) {
      continue
    }
    const body = await readTlsBootstrapCaFile(sourcePath)
    const filtered = filterTlsCertificates(body!)
    sources.push({ key, path: sourcePath, sha256: digest(body!) })
    rejected.push(...filtered.rejectedFingerprints)
    bundlePaths[key] = getTlsTrustBundlePath(directory, key)
    combine(key, filtered.pem)
  }
  if (sfwFiltered.pem && !bundlePaths['NODE_EXTRA_CA_CERTS']) {
    bundlePaths['NODE_EXTRA_CA_CERTS'] = getTlsTrustBundlePath(
      directory,
      'NODE_EXTRA_CA_CERTS',
    )
    combine('NODE_EXTRA_CA_CERTS', '')
  }
  for (const key of CA_KEYS) {
    if (!bundlePaths[key]) {
      bundlePaths[key] = bundlePaths['SSL_CERT_FILE']!
      bundles[key] = bundles['SSL_CERT_FILE']!
    }
  }
  for (const [key, file] of Object.entries(bundlePaths)) {
    await writePrivate(file, bundles[key]!)
  }
  const runtime = {
    ...process.env,
    ...bundlePaths,
    SSL_CERT_DIR: emptyDirectoryPath,
    GIT_SSL_CAPATH: emptyDirectoryPath,
    NODE_OPTIONS: appendNodeOption(process.env['NODE_OPTIONS']),
  }
  const inspection = inspectTlsEnvironment(runtime, {
    platform: process.platform,
    execArgv: process.execArgv,
    controlledSslCertDir: emptyDirectoryPath,
  })
  if (!inspection.ok) {
    throw new Error([...inspection.conflicts, ...inspection.errors].join(' '))
  }
  if (rejected.length) {
    // oxlint-disable-next-line socket/no-direct-stream-write -- Keep the CA filtering diagnostic on stderr.
    process.stderr.write(
      `Filtered blocked CA keys: ${[...new Set(rejected)].join(', ')}\n`,
    )
  }
  const state: State = { bundlePaths, emptyDirectoryPath, sources, version: 1 }
  await writePrivate(
    getTlsTrustStatePath(directory),
    `${JSON.stringify(state, null, 2)}\n`,
  )
  return state
}

async function readState(): Promise<State> {
  const directory = rootDirectory()
  const statePath = getTlsTrustStatePath(directory)
  const info = await lstat(statePath)
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    !hasPrivateTlsPermissions(info.mode)
  ) {
    throw new Error(
      'TLS trust state is missing or unsafe; rerun the setup action.',
    )
  }
  const value = JSON.parse(await readFile(statePath, 'utf8')) as State
  if (
    value.version !== 1 ||
    value.emptyDirectoryPath !==
      getTlsTrustDisabledCaDirectoryPath(directory) ||
    !value.bundlePaths ||
    !Array.isArray(value.sources)
  ) {
    throw new Error('TLS trust state is invalid; rerun the setup action.')
  }
  for (const key of CA_KEYS) {
    if (!Object.hasOwn(value.bundlePaths, key)) {
      throw new Error('TLS trust state is incomplete; rerun the setup action.')
    }
  }
  for (const [key, file] of Object.entries(value.bundlePaths)) {
    if (
      !(CA_KEYS as readonly string[]).includes(key) ||
      path.dirname(path.resolve(file)) !== path.resolve(directory)
    ) {
      throw new Error(
        'TLS trust state contains an unexpected bundle path; rerun the setup action.',
      )
    }
  }
  return value
}

async function validateState(
  state: State,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (
    env['SSL_CERT_DIR'] !== state.emptyDirectoryPath ||
    env['GIT_SSL_CAPATH'] !== state.emptyDirectoryPath
  ) {
    throw new Error('TLS CA directories changed; rerun the setup action.')
  }
  const liveInspection = inspectTlsEnvironment(
    {
      ...env,
      NODE_OPTIONS: appendNodeOption(env['NODE_OPTIONS']),
    },
    {
      platform: process.platform,
      execArgv: process.execArgv,
      controlledSslCertDir: state.emptyDirectoryPath,
    },
  )
  if (!liveInspection.ok) {
    throw new Error(
      [...liveInspection.conflicts, ...liveInspection.errors].join(' '),
    )
  }
  const directory = rootDirectory()
  const directoryInfo = await lstat(directory)
  if (
    !directoryInfo.isDirectory() ||
    directoryInfo.isSymbolicLink() ||
    !hasPrivateTlsPermissions(directoryInfo.mode)
  ) {
    throw new Error(
      'TLS trust directory is not private; rerun the setup action.',
    )
  }
  validateSfwTlsRuntimeMarkerPair(env)
  const runtimeDirectory = env[TLS_RUNTIME_DIRECTORY_KEY]
  const runtimeRoot = runtimeDirectory
    ? await sfwTlsRuntimeDirectoryRoot(env)
    : undefined
  const runtimeReady = await runtimeTlsTrustReady(env, state.bundlePaths, {
    ...(runtimeRoot ? { allowedDirectoryRoot: runtimeRoot } : {}),
  })
  if (runtimeDirectory && !runtimeReady) {
    throw new Error('TLS runtime bundle changed; rerun the setup action.')
  }
  for (const key of CA_KEYS) {
    if (env[key] !== state.bundlePaths[key] && !runtimeReady) {
      throw new Error(
        `${key} changed after TLS trust setup; rerun the setup action.`,
      )
    }
  }
  for (const file of Object.values(state.bundlePaths)) {
    const info = await lstat(file)
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      !hasPrivateTlsPermissions(info.mode)
    ) {
      throw new Error(
        'A managed TLS bundle is missing or unsafe; rerun the setup action.',
      )
    }
    const content = await readTlsBootstrapCaFile(file)
    if (filterTlsCertificates(content!).rejectedFingerprints.length) {
      throw new Error(
        'A managed TLS bundle contains a blocked CA; rerun the setup action.',
      )
    }
  }
  if (!(await isTlsTrustDisabledCaDirectorySafe(state.emptyDirectoryPath))) {
    throw new Error(
      'Managed disabled CA directory is missing, unsafe, or contains unrecognized files.',
    )
  }
  await validateTlsBootstrapSources(state.sources)
  const runtime = {
    ...env,
    ...state.bundlePaths,
    SSL_CERT_DIR: state.emptyDirectoryPath,
    GIT_SSL_CAPATH: state.emptyDirectoryPath,
    NODE_OPTIONS: appendNodeOption(env['NODE_OPTIONS']),
  }
  const inspection = inspectTlsEnvironment(runtime, {
    platform: process.platform,
    execArgv: process.execArgv,
    controlledSslCertDir: state.emptyDirectoryPath,
  })
  if (!inspection.ok) {
    throw new Error([...inspection.conflicts, ...inspection.errors].join(' '))
  }
  const expectedStatePath = getTlsTrustStatePath(directory)
  if (env['FLEET_TLS_TRUST_STATE'] !== expectedStatePath) {
    throw new Error('TLS trust state path changed; rerun the setup action.')
  }
  if (env['BASH_ENV'] !== bashEnvPath()) {
    throw new Error(
      'BASH_ENV changed after TLS trust setup; rerun the setup action.',
    )
  }
  const rcInfo = await lstat(bashEnvPath())
  const helperPath = getTlsTrustHelperPath(directory)
  const rcContents = sfwTlsBashEnvContents(helperPath)
  if (
    !rcInfo.isFile() ||
    rcInfo.isSymbolicLink() ||
    !hasPrivateTlsPermissions(rcInfo.mode) ||
    (await readFile(bashEnvPath(), 'utf8')) !== rcContents
  ) {
    throw new Error('BASH_ENV is missing or unsafe; rerun the setup action.')
  }
  const helperInfo = await lstat(helperPath)
  if (
    !helperInfo.isFile() ||
    helperInfo.isSymbolicLink() ||
    !hasPrivateTlsPermissions(helperInfo.mode)
  ) {
    throw new Error(
      'TLS bootstrap helper is missing or unsafe; rerun the setup action.',
    )
  }
}

async function installBashEnv(sourceHelper: string): Promise<void> {
  const existingBashEnv = process.env['BASH_ENV']
  if (existingBashEnv && existingBashEnv !== bashEnvPath()) {
    throw new Error(
      'BASH_ENV is already set; preserve it and configure filtered TLS trust manually.',
    )
  }
  const directory = rootDirectory()
  const helper = getTlsTrustHelperPath(directory)
  const helperContents = await readFile(sourceHelper)
  await writePrivate(helper, helperContents.toString('utf8'))
  await writePrivate(bashEnvPath(), sfwTlsBashEnvContents(helper))
}

async function main(args: string[]): Promise<void> {
  if (args.length !== 1 || !['--github-env', '--shell'].includes(args[0]!)) {
    throw new Error(
      'Usage: tls-trust-bootstrap.generated.mjs --github-env|--shell',
    )
  }
  if (args[0] === '--github-env') {
    if (
      process.env[TLS_RUNTIME_DIRECTORY_KEY] ||
      process.env[TLS_RUNTIME_CA_KEY]
    ) {
      throw new Error(
        'Cannot rebuild TLS trust while runtime trust markers are active; restart the job.',
      )
    }
    if (process.env['BASH_ENV']) {
      if (process.env['BASH_ENV'] !== bashEnvPath()) {
        throw new Error(
          'BASH_ENV is already set; preserve it and configure filtered TLS trust manually.',
        )
      }
      await validateState(await readState())
    }
    const state = await buildBundles()
    await installBashEnv(process.argv[1]!)
    for (const line of sfwTlsEnvironmentLines({
      bundlePaths: state.bundlePaths,
      emptyDirectoryPath: state.emptyDirectoryPath,
      bash: false,
      bashEnvPath: bashEnvPath(),
      statePath: getTlsTrustStatePath(rootDirectory()),
      env: process.env,
    })) {
      // oxlint-disable-next-line socket/no-direct-stream-write -- Shell startup consumes these lines as environment assignments.
      process.stdout.write(`${line}\n`)
    }
    return
  }
  const state = await readState()
  const runtimeEnv = await resolveSfwTlsOverlay(
    process.env,
    state.bundlePaths,
    state.emptyDirectoryPath,
    process.env['SOCKET_SHIM_ACTIVE_PNPM'] === '1'
      ? await sfwTlsRuntimeDirectoryRoot(process.env)
      : '',
  )
  await validateState(state, runtimeEnv)
  for (const line of sfwTlsEnvironmentLines({
    bundlePaths: state.bundlePaths,
    emptyDirectoryPath: state.emptyDirectoryPath,
    bash: true,
    bashEnvPath: bashEnvPath(),
    statePath: getTlsTrustStatePath(rootDirectory()),
    env: runtimeEnv,
    nodeOptions: appendNodeOption(runtimeEnv['NODE_OPTIONS']),
  })) {
    // oxlint-disable-next-line socket/no-direct-stream-write -- Shell startup consumes these lines as environment assignments.
    process.stdout.write(`${line}\n`)
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    // oxlint-disable-next-line socket/no-direct-stream-write -- Keep CLI errors on stderr without modifying their text.
    process.stderr.write(`${errorMessage(error)}\n`)
    process.exitCode = 1
  })
}
