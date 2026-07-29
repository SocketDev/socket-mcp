/**
 * @file CLI startup: pick the transport, satisfy the auth preconditions, and
 *   hand off to the serving entry. Every environment read and every effect is
 *   a field on `SocketMcpCliDeps`, so `runSocketMcpCli` is a decision over
 *   values a test supplies while `createSocketMcpCliDeps` snapshots the real
 *   ones for `index.ts`. Diagnostics go through `logger` to stderr — stdio mode
 *   gives stdout to the MCP protocol.
 */

import { serveStdio } from '@modelcontextprotocol/server/stdio'

import { errorMessage } from '@socketsecurity/lib/errors/message'

import { getMcpHttpMode, getMcpPort, getSocketApiToken } from './env.ts'
import { getApiKeyInteractively } from './http-helpers.ts'
import { startHttpServer } from './http-server.ts'
import { logger } from './logger.ts'
import { hasAnyOAuthConfig, setOauthEnabled } from './oauth.ts'
import { loadOAuthMetadata } from './oauth-discovery.ts'
import { createConfiguredServer, setStaticApiKey } from './server.ts'
import { VERSION } from './version.ts'

/**
 * Everything startup reads from the environment or acts on the world with.
 * The values are snapshots taken before the run; the functions are the real
 * implementations `createSocketMcpCliDeps` wires in.
 */
export interface SocketMcpCliDeps {
  // True when any of the three OAuth settings is present, so a partial
  // configuration is refused instead of silently serving unauthenticated.
  readonly anyOAuthConfig: boolean
  // The resolved Socket API token, or undefined when no alias is set.
  readonly apiToken: string | undefined
  readonly argv: readonly string[]
  readonly envHttpMode: boolean
  readonly loadOAuthMetadata: () => Promise<unknown>
  readonly port: number
  readonly promptForApiKey: () => Promise<string>
  readonly serveStdio: typeof serveStdio
  readonly setOauthEnabled: () => { issuer: string } | undefined
  readonly setStaticApiKey: typeof setStaticApiKey
  readonly startHttpServer: typeof startHttpServer
}

export const INCOMPLETE_OAUTH_CONFIG_MSG =
  'Incomplete OAuth configuration for HTTP mode. Set SOCKET_OAUTH_ISSUER, SOCKET_OAUTH_INTROSPECTION_CLIENT_ID, and SOCKET_OAUTH_INTROSPECTION_CLIENT_SECRET together.'

// Snapshot the real environment and wire the real effects. Reading the env
// here rather than inside `runSocketMcpCli` is what lets a test drive startup
// without touching `process.env`.
export function createSocketMcpCliDeps(): SocketMcpCliDeps {
  return {
    anyOAuthConfig: hasAnyOAuthConfig,
    apiToken: getSocketApiToken(),
    argv: process.argv,
    envHttpMode: getMcpHttpMode(),
    loadOAuthMetadata,
    port: getMcpPort(),
    promptForApiKey: getApiKeyInteractively,
    serveStdio,
    setOauthEnabled,
    setStaticApiKey,
    startHttpServer,
  }
}

// The stdio transport's `onerror` sink.
export function logStdioTransportError(error: unknown): void {
  logger.error(`Socket MCP stdio error: ${errorMessage(error)}`)
}

// Last-resort report for a startup rejection. `runSocketMcpCli` answers an
// exit code for every failure it decides on, so this covers what it cannot:
// a throw from building the dependency snapshot, or from the interactive
// token prompt.
export function reportSocketMcpStartupFailure(error: unknown): void {
  logger.error(`Socket MCP startup failed: ${errorMessage(error)}`)
  process.exitCode = 1
}

/**
 * Run CLI startup and answer the process exit code — 0 when a transport is
 * serving, 1 when a precondition refused. The caller owns `process.exitCode`
 * so this stays a plain function a test can call.
 */
export async function runSocketMcpCli(deps: SocketMcpCliDeps): Promise<number> {
  // MCP_HTTP_MODE is the env-driven default; the `--http` CLI flag overrides
  // it.
  const useHttp = deps.envHttpMode || deps.argv.includes('--http')

  // OAuth is an HTTP-mode-only posture, so a truthy result also means
  // `useHttp`.
  const oauthResult = useHttp ? deps.setOauthEnabled() : undefined

  if (useHttp && deps.anyOAuthConfig && !oauthResult) {
    logger.error(INCOMPLETE_OAUTH_CONFIG_MSG)
    return 1
  }

  let apiKey = deps.apiToken ?? ''

  if (!apiKey && !oauthResult) {
    if (useHttp) {
      logger.error('SOCKET_API_TOKEN environment variable is not set')
      apiKey = await deps.promptForApiKey()
    } else {
      logger.error(
        'SOCKET_API_TOKEN environment variable is required in stdio mode',
      )
      logger.error(
        'Please set SOCKET_API_TOKEN (or one of the legacy aliases) and try again',
      )
      return 1
    }
  }

  // `shared` marks the static key as a deploy-operator key in HTTP mode, so
  // per-tenant tools refuse to fall back to it and use the caller's
  // per-request token instead. In stdio mode the static key is the local
  // user's own token, so it stays usable everywhere.
  deps.setStaticApiKey(apiKey, { shared: useHttp })

  if (oauthResult) {
    try {
      await deps.loadOAuthMetadata()
      logger.info(
        `Enabled OAuth-backed MCP auth with issuer ${oauthResult.issuer}`,
      )
    } catch (e) {
      logger.error(`Failed to initialize OAuth metadata: ${errorMessage(e)}`)
      return 1
    }
  }

  if (useHttp) {
    deps.startHttpServer(deps.port)
    return 0
  }

  logger.info('Starting in stdio mode')
  try {
    // serveStdio owns the transport and calls the factory per connection —
    // including the discarded `server/discover` probe — so it takes
    // `createConfiguredServer` itself, not one instance. Its default
    // `legacy` posture serves 2025-era clients alongside 2026-era ones.
    deps.serveStdio(createConfiguredServer, { onerror: logStdioTransportError })
    logger.info(`Socket MCP server version ${VERSION} started successfully`)
  } catch (e) {
    logger.error(`Failed to start Socket MCP server: ${errorMessage(e)}`)
    return 1
  }
  return 0
}
