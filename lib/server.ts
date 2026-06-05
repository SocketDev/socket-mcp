import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

import { getSocketApiUrl } from './env.ts'
import { defineAlertsTool } from './tool-alerts.ts'
import { defineDepscoreTool } from './tool-depscore.ts'
import {
  definePackageFileContentsTool,
  definePackageFileGrepTool,
  definePackageFilesTool,
} from './tool-package-files.ts'
import { defineOrganizationsTool } from './tool-organizations.ts'
import { defineThreatFeedTool } from './tool-threat-feed.ts'
import { withToolLogging } from './tool-logging.ts'
import type { ToolHandler } from './tool-logging.ts'
import type {
  ToolCallResult,
  ToolHandlerExtra,
  ToolSpec,
} from './tool-types.ts'
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
  'Authentication is required. Set SOCKET_API_TOKEN for stdio mode, or send your Socket API token as an `Authorization: Bearer <token>` header (or connect through OAuth) in HTTP mode.'

// Boot-time static API key. In stdio mode this is the local user's own token
// (set from SOCKET_API_TOKEN in index.ts), so it is safe to use for any tool.
// In HTTP mode it is the deploy operator's token, shared across every caller —
// `staticApiKeyShared` records that distinction so per-tenant tools never hand
// the operator's private data to an arbitrary caller.
let staticApiKey: string = ''
let staticApiKeyShared = false

// Shared "auth missing" tool result — every tool returns the same shape so
// clients get a consistent error.
export function authRequiredResult(): ToolErrorResult {
  return errorResult(AUTH_REQUIRED_MSG)
}

/**
 * Build the canonical set of tool specs. Each tool ships its own
 * `define*Tool()` factory so the data + handler stay co-located; this function
 * just collects them. Order here is the order clients see in `tools/list`.
 */
export function buildToolSpecs(): ToolSpec[] {
  return [
    defineDepscoreTool(),
    defineOrganizationsTool(),
    defineAlertsTool(),
    defineThreatFeedTool(),
    definePackageFilesTool(),
    definePackageFileContentsTool(),
    definePackageFileGrepTool(),
  ]
}

/**
 * Build a configured low-level `Server` instance with every Socket tool
 * registered. Used for stdio (single instance) and HTTP (one per session).
 *
 * Migration note: previously this used the high-level `McpServer`, which bakes
 * zod adapters into `registerTool`. The low-level `Server` accepts raw JSON
 * Schema in `Tool.inputSchema` — which is exactly what TypeBox's
 * `Type.Object({...})` produces. So every tool's input schema flows through the
 * SDK to clients verbatim; no zod, no extra validation layer here.
 */
export function createConfiguredServer(): Server {
  const specs = buildToolSpecs()
  const handlers = new Map<string, ToolHandler>(
    specs.map(spec => [
      spec.name,
      withToolLogging(spec.name, spec.handler.bind(spec)),
    ]),
  )

  const server = new Server(
    { name: 'socket', version: VERSION },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: specs.map(spec => ({
      name: spec.name,
      title: spec.title,
      description: spec.description,
      inputSchema: spec.inputSchema,
      ...(spec.annotations ? { annotations: spec.annotations } : {}),
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name } = request.params
    const handler = handlers.get(name)
    if (!handler) {
      // The SDK's CallTool spec returns an error result (not an exception)
      // for an unknown name — clients render it the same way as any other
      // tool error.
      const message = `Unknown tool: ${name}`
      return {
        content: [{ type: 'text', text: message }],
        isError: true,
      } as ToolCallResult
    }
    // `request.params.arguments` is optional in the SDK shape; tools that
    // declare empty inputSchemas (e.g. organizations) get undefined here.
    const args = (request.params.arguments ?? {}) as Record<string, unknown>
    // extra carries authInfo + transport extras; shape-cast to our local
    // type so the handler sees a stable signature.
    return handler(args, extra as unknown as ToolHandlerExtra)
  })

  return server
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

// Resolve the access token a PUBLIC-data tool (depscore) should use: the
// per-request token takes precedence, then the boot-time static key. Falling
// back to a shared deploy key is fine here because package scores are not
// tenant-scoped. Returns undefined when neither is available.
export function resolveAuthToken(
  authInfoToken: string | undefined,
): string | undefined {
  return authInfoToken || staticApiKey || undefined
}

// Resolve the access token a PER-TENANT tool (organizations, alerts,
// threat_feed, package_files) should use. The per-request token always wins.
// The static key is only an acceptable fallback when it is the local user's
// own token (stdio mode); in HTTP mode the static key belongs to the deploy
// operator, so returning it would expose the operator's private org data to
// every caller. Returns undefined in that case so the tool emits
// AUTH_REQUIRED instead of silently acting as the operator.
export function resolveScopedAuthToken(
  authInfoToken: string | undefined,
): string | undefined {
  if (authInfoToken) {
    return authInfoToken
  }
  if (!staticApiKeyShared && staticApiKey) {
    return staticApiKey
  }
  return undefined
}

// Set the static API key. Called once during boot from index.ts. `shared`
// marks the key as a deploy-operator key (HTTP mode) rather than the local
// user's own (stdio mode). Subsequent calls overwrite — only the most recent
// value is used.
export function setStaticApiKey(
  value: string,
  options?: { shared?: boolean | undefined } | undefined,
): void {
  staticApiKey = value
  staticApiKeyShared = options?.shared ?? false
}
