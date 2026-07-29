#!/usr/bin/env node
import {
  createSocketMcpCliDeps,
  reportSocketMcpStartupFailure,
  runSocketMcpCli,
} from './lib/cli.ts'

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
export { createConfiguredServer } from './lib/server.ts'
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
  process.exitCode = await runSocketMcpCli(createSocketMcpCliDeps())
}

main().catch(reportSocketMcpStartupFailure)
