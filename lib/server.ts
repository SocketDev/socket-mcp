import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { getSocketApiUrl } from './env.ts'
import { registerAlertsTool } from './register-alerts.ts'
import { registerDepscoreTool } from './register-depscore.ts'
import { registerOrganizationsTool } from './register-organizations.ts'
import { registerPackageFilesTools } from './register-package-files.ts'
import { registerThreatFeedTool } from './register-threat-feed.ts'
import { withToolLogging } from './tool-logging.ts'
import { VERSION } from './version.ts'

export interface ToolErrorResult {
  [key: string]: unknown
  content: Array<{ type: 'text'; text: string }>
  isError: true
}

export interface ToolOkResult {
  [key: string]: unknown
  content: Array<{ type: 'text'; text: string }>
}

// Base URL for the org-scoped Socket REST API (alerts, organizations,
// threat-feed, file-list). Shared by every tool module so the fallback lives
// in one place.
export const SOCKET_API_BASE_URL = getSocketApiUrl() || 'https://api.socket.dev'

// The single auth-missing message every tool returns when no token is
// available — kept here so the wording stays identical across tools.
export const AUTH_REQUIRED_MSG =
  'Authentication is required. Configure SOCKET_API_TOKEN (or a legacy alias) for stdio mode or connect through OAuth-enabled HTTP mode.'

// Boot-time static API key (stdio mode reads it from SOCKET_API_TOKEN via
// setStaticApiKey in index.ts). Tools fall back to it when a request carries
// no per-request authInfo token.
let staticApiKey: string = ''

// Shared "auth missing" tool result — every tool returns the same shape so
// clients get a consistent error.
export function authRequiredResult(): ToolErrorResult {
  return errorResult(AUTH_REQUIRED_MSG)
}

// Build a configured McpServer with every Socket tool registered. Used for
// stdio (single instance) and HTTP (one per session). withToolLogging wraps
// registerTool so all tools get uniform call/error logging.
export function createConfiguredServer(): McpServer {
  const srv = withToolLogging(
    new McpServer({ name: 'socket', version: VERSION }),
  )
  registerDepscoreTool(srv)
  registerOrganizationsTool(srv)
  registerAlertsTool(srv)
  registerThreatFeedTool(srv)
  registerPackageFilesTools(srv)
  return srv
}

export function errorResult(text: string): ToolErrorResult {
  return {
    content: [{ type: 'text', text }],
    isError: true,
  }
}

export function getStaticApiKey(): string {
  return staticApiKey
}

// Resolve the access token a tool should use: the per-request OAuth token
// (HTTP mode) takes precedence, falling back to the boot-time static key
// (stdio mode). Returns undefined when neither is available.
export function resolveAuthToken(
  authInfoToken: string | undefined,
): string | undefined {
  return authInfoToken || staticApiKey || undefined
}

// Set the static API key. Called once during boot from index.ts. Subsequent
// calls overwrite — only the most recent value is used.
export function setStaticApiKey(value: string): void {
  staticApiKey = value
}
