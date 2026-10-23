import process from 'node:process'
import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { inspectTlsEnvironment } from '../../../../scripts/fleet/process/tls-policy.mts'
import {
  CA_SOURCE_KEYS,
  readTlsTrustFile,
} from '../../../../scripts/fleet/setup/tls-trust-bundles.mts'
import {
  createRuntimeTlsTrust,
  reuseRuntimeTlsTrust,
  TLS_RUNTIME_CA_KEY,
  TLS_RUNTIME_DIRECTORY_KEY,
} from '../../../../scripts/fleet/setup/tls-trust-runtime-bundles.mts'
import {
  getTlsTrustRootPath,
  TLS_SFW_BUNDLE_KEYS,
} from '../../../../scripts/fleet/paths/tls-trust.mts'
import { hasPrivateTlsPermissions } from '../../../../scripts/fleet/setup/tls-trust-permissions.mts'

const SFW_BUNDLE_KEYS = TLS_SFW_BUNDLE_KEYS

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

export function sfwTlsBashEnvContents(helperPath: string): string {
  const command = `${shellQuote(process.execPath)} ${shellQuote(helperPath)} --shell`
  return [
    `if ! FLEET_TLS_TRUST_EXPORTS="$(${command})"; then`,
    '  exit 1',
    'fi',
    'eval "$FLEET_TLS_TRUST_EXPORTS"',
    'unset FLEET_TLS_TRUST_EXPORTS',
    '',
  ].join('\n')
}

export async function sfwTlsRuntimeDirectoryRoot(
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const runnerTemp = env['RUNNER_TEMP']
  if (!runnerTemp || !path.isAbsolute(runnerTemp)) {
    throw new Error('Socket Firewall requires an absolute RUNNER_TEMP path.')
  }
  const runnerPath = path.resolve(runnerTemp)
  const runnerInfo = await lstat(runnerPath)
  if (
    !runnerInfo.isDirectory() ||
    runnerInfo.isSymbolicLink() ||
    (await realpath(runnerPath)) !== runnerPath
  ) {
    throw new Error('Socket Firewall RUNNER_TEMP is not a real directory.')
  }
  const root = getTlsTrustRootPath(runnerPath)
  const rootInfo = await lstat(root)
  if (
    !rootInfo.isDirectory() ||
    rootInfo.isSymbolicLink() ||
    !hasPrivateTlsPermissions(rootInfo.mode) ||
    (await realpath(root)) !== root
  ) {
    throw new Error('Socket Firewall TLS state directory is not private.')
  }
  return root
}

export function validateSfwTlsRuntimeMarkerPair(env: NodeJS.ProcessEnv): void {
  if (
    Boolean(env[TLS_RUNTIME_DIRECTORY_KEY]) !== Boolean(env[TLS_RUNTIME_CA_KEY])
  ) {
    throw new Error('TLS runtime trust markers are incomplete; rerun setup.')
  }
}

export function sfwTlsEnvironmentLines(config: {
  bundlePaths: Record<string, string>
  emptyDirectoryPath: string
  bash: boolean
  bashEnvPath: string
  statePath: string
  env: NodeJS.ProcessEnv
  nodeOptions?: string | undefined
}): string[] {
  const values = {
    ...Object.fromEntries(
      CA_SOURCE_KEYS.map(key => [
        key,
        config.bash
          ? (config.env[key] ?? config.bundlePaths[key]!)
          : config.bundlePaths[key]!,
      ]),
    ),
    SSL_CERT_DIR: config.emptyDirectoryPath,
    GIT_SSL_CAPATH: config.emptyDirectoryPath,
    ...(config.nodeOptions ? { NODE_OPTIONS: config.nodeOptions } : {}),
    BASH_ENV: config.bashEnvPath,
    FLEET_TLS_TRUST_STATE: config.statePath,
    [TLS_RUNTIME_DIRECTORY_KEY]: config.env[TLS_RUNTIME_DIRECTORY_KEY] ?? '',
    [TLS_RUNTIME_CA_KEY]: config.env[TLS_RUNTIME_CA_KEY] ?? '',
    ...(config.bash && config.env[TLS_RUNTIME_DIRECTORY_KEY]
      ? {
          [TLS_RUNTIME_DIRECTORY_KEY]: config.env[TLS_RUNTIME_DIRECTORY_KEY],
          [TLS_RUNTIME_CA_KEY]: config.env[TLS_RUNTIME_CA_KEY],
        }
      : {}),
  }
  return Object.entries(values).map(([key, value]) =>
    config.bash ? `export ${key}=${shellQuote(value)}` : `${key}=${value}`,
  )
}

export async function resolveSfwTlsOverlay(
  env: NodeJS.ProcessEnv,
  bundlePaths: Record<string, string>,
  emptyDirectoryPath: string,
  runtimeDirectoryRoot: string,
): Promise<NodeJS.ProcessEnv> {
  if (env['SOCKET_SHIM_ACTIVE_PNPM'] !== '1') {
    return env
  }
  const source = env['NODE_EXTRA_CA_CERTS']
  if (!env[TLS_RUNTIME_DIRECTORY_KEY] && env[TLS_RUNTIME_CA_KEY]) {
    throw new Error(
      'Socket Firewall runtime trust markers are incomplete; restart the wrapped command.',
    )
  }
  const runtimeEnv = env[TLS_RUNTIME_DIRECTORY_KEY]
    ? await reuseRuntimeTlsTrust(env, bundlePaths, {
        allowSfwOverlay: true,
        allowedDirectoryRoot: runtimeDirectoryRoot,
      })
    : undefined
  if (env[TLS_RUNTIME_DIRECTORY_KEY] && !runtimeEnv) {
    throw new Error(
      'Socket Firewall runtime trust changed; restart the wrapped command.',
    )
  }
  if (
    !env[TLS_RUNTIME_DIRECTORY_KEY] &&
    !env[TLS_RUNTIME_CA_KEY] &&
    CA_SOURCE_KEYS.every(key => env[key] === bundlePaths[key]) &&
    env['SSL_CERT_DIR'] === emptyDirectoryPath &&
    env['GIT_SSL_CAPATH'] === emptyDirectoryPath
  ) {
    return env
  }
  if (!source) {
    throw new Error(
      'Socket Firewall CA source is missing; restart the wrapped command.',
    )
  }
  const runtimeCaSource = env[TLS_RUNTIME_CA_KEY]
  const runtimeAlreadyNormalized = Boolean(
    runtimeEnv &&
    source === runtimeEnv['NODE_EXTRA_CA_CERTS'] &&
    CA_SOURCE_KEYS.every(key => env[key] === runtimeEnv[key]),
  )
  if (runtimeAlreadyNormalized) {
    return runtimeEnv!
  }
  if (
    Object.values(bundlePaths).includes(source) ||
    (runtimeCaSource && source !== runtimeCaSource)
  ) {
    throw new Error(
      'Socket Firewall CA source changed after runtime trust setup; restart the wrapped command.',
    )
  }
  const sfwBundle = env['SSL_CERT_FILE']
  if (
    !sfwBundle ||
    sfwBundle === source ||
    Object.values(bundlePaths).includes(sfwBundle) ||
    SFW_BUNDLE_KEYS.some(key => env[key] !== sfwBundle)
  ) {
    throw new Error(
      'Socket Firewall CA bundle does not match its filtered source; restart the wrapped command.',
    )
  }
  for (const key of CA_SOURCE_KEYS) {
    if (
      key !== 'NODE_EXTRA_CA_CERTS' &&
      !(SFW_BUNDLE_KEYS as readonly string[]).includes(key)
    ) {
      if (env[key] !== bundlePaths[key] && env[key] !== runtimeEnv?.[key]) {
        throw new Error(
          `${key} changed during Socket Firewall wrapping; restart the wrapped command.`,
        )
      }
    }
    if (!bundlePaths[key]) {
      throw new Error(`TLS state is missing ${key}; rerun the setup action.`)
    }
  }
  await readTlsTrustFile(sfwBundle)
  if (
    env['SSL_CERT_DIR'] !== emptyDirectoryPath ||
    env['GIT_SSL_CAPATH'] !== emptyDirectoryPath
  ) {
    throw new Error(
      'TLS CA directories changed during Socket Firewall wrapping; restart the wrapped command.',
    )
  }
  const inspectionEnv = {
    ...env,
    NODE_EXTRA_CA_CERTS: bundlePaths['NODE_EXTRA_CA_CERTS'],
    ...Object.fromEntries(SFW_BUNDLE_KEYS.map(key => [key, bundlePaths[key]])),
  }
  const inspection = inspectTlsEnvironment(inspectionEnv, {
    platform: process.platform,
    execArgv: process.execArgv,
    controlledSslCertDir: emptyDirectoryPath,
  })
  if (!inspection.ok) {
    throw new Error([...inspection.conflicts, ...inspection.errors].join(' '))
  }
  if (runtimeEnv) return runtimeEnv
  return await createRuntimeTlsTrust(env, bundlePaths, source, {
    directoryRoot: runtimeDirectoryRoot,
  })
}
