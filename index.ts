#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { errorMessage } from '@socketsecurity/lib/errors'

import { getMcpHttpMode, getMcpPort, getSocketApiToken } from './lib/env.ts'

import { createConfiguredServer, setStaticApiKey } from './lib/depscore-tool.ts'
import { getApiKeyInteractively } from './lib/http-helpers.ts'
import { startHttpServer } from './lib/http-server.ts'
import { logger } from './lib/logger.ts'
import {
  hasAnyOAuthConfig,
  loadOAuthMetadata,
  setOauthEnabled,
} from './lib/oauth.ts'
import { VERSION } from './lib/version.ts'

// Re-export the module's public surface so existing consumers (tests,
// downstream importers) continue to work after the split.
export {
  buildSocketHeaders,
  getApiKeyInteractively,
  getForwardedHeaderValue,
  getRequestBaseUrl,
  getRequestHeaderValue,
  parseJsonObject,
  writeJson,
  writeOAuthError,
} from './lib/http-helpers.ts'
export { createConfiguredServer } from './lib/depscore-tool.ts'
export {
  authenticateRequest,
  buildProtectedResourceMetadata,
  getProtectedResourceMetadataUrl,
  loadOAuthMetadata,
  splitScopes,
  verifyAccessToken,
} from './lib/oauth.ts'

// Wrap CLI startup in an async main() so rolldown can bundle to CJS
// (top-level await isn't supported in CJS output).
async function main(): Promise<void> {
  // MCP_HTTP_MODE / MCP_PORT resolved via fleet-canonical helpers in
  // @socketsecurity/lib/env/socket. `--http` CLI flag still overrides
  // the env-driven default.
  const useHttp = getMcpHttpMode() || process.argv.includes('--http')
  const port = getMcpPort()

  const oauthEnabledResult = useHttp ? setOauthEnabled() : undefined
  const oauthEnabled = Boolean(oauthEnabledResult)

  if (useHttp && hasAnyOAuthConfig && !oauthEnabled) {
    logger.error(
      'Incomplete OAuth configuration for HTTP mode. Set SOCKET_OAUTH_ISSUER, SOCKET_OAUTH_INTROSPECTION_CLIENT_ID, and SOCKET_OAUTH_INTROSPECTION_CLIENT_SECRET together.',
    )
    process.exitCode = 1
    return
  }

  // Resolve the API token via the fleet-canonical helper. Accepts (in
  // priority order) SOCKET_API_TOKEN → SOCKET_CLI_API_TOKEN →
  // SOCKET_CLI_API_KEY → SOCKET_SECURITY_API_TOKEN → SOCKET_SECURITY_API_KEY.
  let apiKey = getSocketApiToken() || ''

  if (!apiKey && !(useHttp && oauthEnabled)) {
    if (useHttp) {
      logger.error('SOCKET_API_TOKEN environment variable is not set')
      apiKey = await getApiKeyInteractively()
    } else {
      logger.error(
        'SOCKET_API_TOKEN environment variable is required in stdio mode',
      )
      logger.error(
        'Please set SOCKET_API_TOKEN (or one of the legacy aliases) and try again',
      )
      process.exitCode = 1
      return
    }
  }

  setStaticApiKey(apiKey)

  if (oauthEnabled && oauthEnabledResult) {
    try {
      await loadOAuthMetadata()
      logger.info(
        `Enabled OAuth-backed MCP auth with issuer ${oauthEnabledResult.issuer}`,
      )
    } catch (error) {
      logger.error(
        `Failed to initialize OAuth metadata: ${errorMessage(error)}`,
      )
      process.exitCode = 1
      return
    }
  }

  if (useHttp) {
    startHttpServer(port)
  } else {
    logger.info('Starting in stdio mode')
    const server = createConfiguredServer()
    const transport = new StdioServerTransport()
    try {
      await server.connect(transport)
      logger.info(`Socket MCP server version ${VERSION} started successfully`)
    } catch (error) {
      logger.error(`Failed to start Socket MCP server: ${errorMessage(error)}`)
      process.exitCode = 1
      return
    }
  }
}

main().catch(error => {
  logger.error(`Socket MCP startup failed: ${errorMessage(error)}`)
  process.exitCode = 1
})
