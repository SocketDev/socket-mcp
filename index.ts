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
  process.exit(1)
}

// Resolve the API token via the fleet-canonical helper. Accepts (in
// priority order) SOCKET_API_TOKEN → SOCKET_CLI_API_TOKEN →
// SOCKET_CLI_API_KEY → SOCKET_SECURITY_API_TOKEN → SOCKET_SECURITY_API_KEY.
// Centralizing the fallback chain in @socketsecurity/lib means every
// fleet binary (cli, mcp, sdk consumers) accepts the same set of
// names; adding/removing an alias is a one-line change upstream.
let apiKey = getSocketApiToken() || ''

// Stdio mode cannot prompt — stdin is the MCP protocol channel — so we
// require the env var. HTTP mode can prompt on stderr or rely entirely
// on OAuth.
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
    process.exit(1)
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
    logger.error(`Failed to initialize OAuth metadata: ${errorMessage(error)}`)
    process.exit(1)
  }
}

if (useHttp) {
  startHttpServer(port)
} else {
  logger.info('Starting in stdio mode')
  const server = createConfiguredServer()
  const transport = new StdioServerTransport()
  server
    .connect(transport)
    .then(() => {
      logger.info(`Socket MCP server version ${VERSION} started successfully`)
    })
    .catch((error: Error) => {
      logger.error(`Failed to start Socket MCP server: ${error.message}`)
      process.exit(1)
    })
}
