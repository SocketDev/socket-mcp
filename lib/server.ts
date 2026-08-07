import { Server } from '@modelcontextprotocol/server'
import type { ServerContext } from '@modelcontextprotocol/server'

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
  ToolAnnotations,
  ToolHandlerExtra,
  ToolInputSchema,
  ToolSpec,
} from './tool-types.ts'
import { VERSION } from './version.ts'

// One entry in the `tools/list` payload — the wire shape clients read.
export interface ToolListEntry {
  annotations?: ToolAnnotations | undefined
  description: string
  inputSchema: ToolInputSchema
  name: string
  title: string
}

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

// `tools/list` is a cacheable result on the 2026-07-28 revision: the SDK
// stamps `ttlMs`/`cacheScope` onto the wire response from this hint. The tool
// set only changes when a new socket-mcp ships and is identical for every
// caller, so a one-hour shared-cache lifetime is safe.
const TOOLS_LIST_CACHE_TTL_MS = 60 * 60 * 1000

// Shared "auth missing" tool result — every tool returns the same shape so
// clients get a consistent error.
export function authRequiredResult(): ToolErrorResult {
  return errorResult(AUTH_REQUIRED_MSG)
}

/**
 * Build the canonical set of tool specs. Each tool ships its own
 * `define*Tool()` factory so the data + handler stay co-located; this function
 * just collects them and hands each schema through `toPlainSchemaSpec`. Order
 * here is the order clients see in `tools/list`.
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
  ].map(toPlainSchemaSpec)
}

/**
 * Build a configured low-level `Server` instance with every Socket tool
 * registered. Both serving entries take this as their factory and own the
 * lifetime of what it returns — `serveStdio` closes its discarded
 * `server/discover` probe instance and `createMcpHandler` closes the instance
 * it built after each HTTP exchange — so every call must hand back a fresh
 * `Server`.
 *
 * The low-level `Server` accepts raw JSON Schema in `Tool.inputSchema`, which
 * is exactly what TypeBox's `Type.Object({...})` produces, and `tools/list`
 * results are not re-parsed on the way out. So every tool's input schema flows
 * through the SDK to clients verbatim; no zod, no extra validation layer here.
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
    {
      capabilities: { tools: {} },
      cacheHints: {
        'tools/list': {
          ttlMs: TOOLS_LIST_CACHE_TTL_MS,
          cacheScope: 'public',
        },
      },
    },
  )

  server.setRequestHandler('tools/list', () => ({
    tools: specs.map(toToolListEntry),
  }))

  server.setRequestHandler('tools/call', async (request, ctx) => {
    const { name } = request.params
    const handler = handlers.get(name)
    if (!handler) {
      // The CallTool spec returns an error result (not an exception) for an
      // unknown name — clients render it the same way as any other tool error.
      const message = `Unknown tool: ${name}`
      return {
        content: [{ type: 'text', text: message }],
        isError: true,
      }
    }
    // `request.params.arguments` is optional in the SDK shape; tools that
    // declare empty inputSchemas (e.g. organizations) get undefined here.
    const args = request.params.arguments ?? {}
    return handler(args, toToolHandlerExtra(ctx))
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
  const opts = { __proto__: null, ...options } as {
    shared?: boolean | undefined
  }
  staticApiKey = value
  staticApiKeyShared = opts.shared ?? false
}

/**
 * Return the spec with its `inputSchema` deep-copied into a plain JSON-Schema
 * object. TypeBox's `Type.*` constructors hang symbol-keyed metadata —
 * `Symbol(TypeBox.Kind)`, `Symbol(TypeBox.Optional)` — off every schema node
 * they build, and a symbol key is not JSON Schema. Serializing transports
 * (stdio, Streamable HTTP) drop those symbols on the way out, but a transport
 * that hands objects over by reference passes them straight to the consumer,
 * where a result validator rejects the payload. Copying here makes a spec
 * structurally what it claims to be: raw JSON Schema, safe for any consumer.
 *
 * The JSON round trip is the copy: every schema node holds only strings,
 * numbers, booleans, arrays and plain objects — no `undefined` values, no
 * `Date`/`Map`/`Set` — so the result is byte-identical to what a serializing
 * transport already writes.
 */
export function toPlainSchemaSpec(spec: ToolSpec): ToolSpec {
  // JSON.parse widens to any; the value round-trips through the same
  // encoding every shipping transport applies to it.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- round trip
  const inputSchema = JSON.parse(
    JSON.stringify(spec.inputSchema),
  ) as ToolInputSchema
  return { ...spec, inputSchema }
}

// Adapt the SDK's per-request handler context to the local `ToolHandlerExtra`
// shape the tool modules read. `ctx.http` is only populated on an HTTP
// transport, so stdio callers get an empty extra and fall back to the
// boot-time static key inside the tool body.
export function toToolHandlerExtra(ctx: ServerContext): ToolHandlerExtra {
  const authInfo = ctx.http?.authInfo
  return authInfo ? { authInfo } : {}
}

/**
 * Render one spec as its `tools/list` entry. `annotations` is optional on
 * `ToolSpec`, so a tool that declares none is published without the key rather
 * than with an empty object — clients treat a present-but-empty `annotations`
 * as a set of explicit hints.
 */
export function toToolListEntry(spec: ToolSpec): ToolListEntry {
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: spec.inputSchema,
    ...(spec.annotations ? { annotations: spec.annotations } : {}),
  }
}
