#!/usr/bin/env node
import {
  createSocketMcpCliDeps,
  reportSocketMcpStartupFailure,
  runSocketMcpCli,
} from './lib/cli.mts'
import { loginWithBrowserOAuth, logoutLocalOAuth } from './lib/local-oauth.mts'
import { logger } from './lib/logger.mts'

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
} from './lib/http.mts'
export { createConfiguredServer } from './lib/server.mts'
export {
  authenticateRequest,
  buildProtectedResourceMetadata,
  getProtectedResourceMetadataUrl,
  loadOAuthMetadata,
  splitScopes,
  verifyAccessToken,
} from './lib/oauth.mts'

// Wrap CLI startup in an async main() so rolldown can bundle to CJS
// (top-level await isn't supported in CJS output).
async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'login') {
    if (args.length > 0) {
      logger.error('Usage: socket-mcp login')
      process.exitCode = 1
      return
    }
    await loginWithBrowserOAuth()
    return
  }
  if (command === 'logout') {
    if (args.length > 0) {
      logger.error('Usage: socket-mcp logout')
      process.exitCode = 1
      return
    }
    await logoutLocalOAuth()
    return
  }
  if (command === '--help' || command === '-h') {
    logger.info(
      'Usage: socket-mcp [--http] | socket-mcp login | socket-mcp logout\n' +
        'Local stdio: run `socket-mcp login` for browser OAuth. A raw API token is a discouraged fallback.',
    )
    return
  }
  process.exitCode = await runSocketMcpCli(createSocketMcpCliDeps())
}

main().catch(reportSocketMcpStartupFailure)
