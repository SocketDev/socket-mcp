// HTTP transport module: session lifecycle, request routing (GET/POST/DELETE),
// and the post-body size guard — the cohesive request path that reads
// top-to-bottom. Origin/CORS/Accept-header validation lives in http-origin.ts.
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { errorMessage } from '@socketsecurity/lib/errors/message'
import crypto from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createConfiguredServer } from './server.ts'
import {
  getRequestBaseUrl,
  getRequestHeaderValue,
  writeJson,
} from './http-helpers.ts'
import {
  patchAcceptHeader,
  validateOriginAndHost,
  writeCorsHeaders,
} from './http-origin.ts'
import { logger } from './logger.ts'
import {
  authenticateRequest,
  buildProtectedResourceMetadata,
  getProtectedResourceMetadataUrl,
  isOauthEnabled,
  loadOAuthMetadata,
  OAUTH_PROTECTED_RESOURCE_METADATA_PATH,
} from './oauth.ts'
import type { AuthenticatedRequest } from './oauth.ts'
import { VERSION } from './version.ts'

// Per-session record. Both transport and server must persist for the
// session lifetime — storing the server prevents GC from reclaiming it
// before subsequent RPC calls.
export interface Session {
  transport: StreamableHTTPServerTransport
  server: Server
  lastActivity: number
}

// 30 min idle TTL — well within MCP transport keep-alive expectations
// while bounding memory for forgotten clients.
const SESSION_TTL_MS = 30 * 60 * 1000

// Reaper runs every 60 s; idle sessions older than SESSION_TTL_MS are
// destroyed.
const REAP_INTERVAL_MS = 60_000

// Cap the buffered request body. readPostBody accumulates the whole body
// in memory before JSON.parse, so an unbounded body is a single-request
// heap-exhaustion DoS — reachable on the HTTP transport before auth. 4 MB
// is far above any legitimate MCP JSON-RPC frame.
const MAX_POST_BODY_BYTES = 4 * 1024 * 1024

// Thrown by readPostBody when the body exceeds MAX_POST_BODY_BYTES, so the
// caller can answer 413 instead of a generic 500.
export class PayloadTooLargeError extends Error {
  constructor(limitBytes: number) {
    super(`Request body exceeds the ${limitBytes}-byte limit`)
    this.name = 'PayloadTooLargeError'
  }
}

// Non-OAuth HTTP mode: forward a client-supplied Socket API key (sent as
// `Authorization: Bearer <token>`) to the tool layer via `req.auth`, so
// per-tenant tools act on the caller's behalf instead of the deploy's static
// key. A missing or malformed header leaves `req.auth` unset, which makes
// per-tenant tools return AUTH_REQUIRED while public tools (depscore) still
// fall back to the static key.
export function applyClientApiKey(req: AuthenticatedRequest): void {
  const authHeader = getRequestHeaderValue(req.headers.authorization).trim()
  if (!authHeader) {
    return
  }
  const [type, token] = authHeader.split(/\s+/u)
  if ((type || '').toLowerCase() !== 'bearer' || !token) {
    return
  }
  req.auth = { token, clientId: 'socket-api-key', scopes: [] }
}

// Socket API tokens carry this doc-only example prefix, `sktsec_t_...`; OAuth access — socket-lint: allow socket-api-key
// tokens do not. We use it to recognize a raw Socket key sent over the
// standard `Authorization: Bearer` header so it bypasses OAuth introspection.
const SOCKET_API_KEY_PREFIX = 'sktsec_'

// Recognize a Socket API key on the `Authorization: Bearer` header by its
// `sktsec_` prefix and apply it to `req.auth`, returning true when matched.
// Lets a caller authenticate with a raw Socket key even on an OAuth server:
// the key skips introspection and acts on the caller's behalf, while a
// non-prefixed token (an OAuth access token) falls through to OAuth. An
// invalid key fails at the downstream Socket API call.
export function applySocketApiKey(req: AuthenticatedRequest): boolean {
  const authHeader = getRequestHeaderValue(req.headers.authorization).trim()
  const [type, token] = authHeader.split(/\s+/u)
  if (
    (type || '').toLowerCase() !== 'bearer' ||
    !token ||
    !token.startsWith(SOCKET_API_KEY_PREFIX)
  ) {
    return false
  }
  req.auth = { token, clientId: 'socket-api-key', scopes: [] }
  return true
}

// Destroy a session — close transport (best-effort) and detach the MCP
// server. Safe to call multiple times.
export function destroySession(
  sessions: Map<string, Session>,
  id: string,
): void {
  const s = sessions.get(id)
  if (!s) {
    return
  }
  sessions.delete(id)
  try {
    s.transport.close().catch(() => {})
  } catch {}
  s.server.close().catch(() => {})
  logger.info(`Session ${id} destroyed`)
}

// Handle DELETE / on the MCP endpoint: close out an existing session.
export async function handleDelete(
  sessions: Map<string, Session>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const sessionId =
    getRequestHeaderValue(req.headers['mcp-session-id']) || undefined
  const transport = sessionId ? sessions.get(sessionId)?.transport : undefined
  if (!transport) {
    writeJson(res, 404, {
      jsonrpc: '2.0',
      error: {
        code: -32_000,
        message: 'Not Found: Invalid or expired session.',
      },
      id: undefined,
    })
    return
  }
  try {
    await transport.handleRequest(req, res)
  } catch (error) {
    logger.error(`Error processing DELETE request: ${errorMessage(error)}`)
    if (!res.headersSent) {
      writeJson(res, 500, {
        jsonrpc: '2.0',
        error: { code: -32_603, message: 'Internal server error' },
        id: undefined,
      })
    }
  }
}

// Handle GET / on the MCP endpoint: open the SSE stream for an existing
// session.
export async function handleGet(
  sessions: Map<string, Session>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const sessionId =
    getRequestHeaderValue(req.headers['mcp-session-id']) || undefined
  const session = sessionId ? sessions.get(sessionId) : undefined
  if (!session) {
    writeJson(res, 404, {
      jsonrpc: '2.0',
      error: {
        code: -32_000,
        message: 'Not Found: Invalid or expired session. Re-initialize.',
      },
      id: undefined,
    })
    return
  }
  try {
    session.lastActivity = Date.now()
    await session.transport.handleRequest(req, res)
  } catch (error) {
    logger.error(`Error processing GET request: ${errorMessage(error)}`)
    if (!res.headersSent) {
      writeJson(res, 500, {
        jsonrpc: '2.0',
        error: { code: -32_603, message: 'Internal server error' },
        id: undefined,
      })
    }
  }
}

// Handle POST / on the MCP endpoint: route to an existing session or
// open a new one on receipt of an initialize request.
export async function handlePost(
  sessions: Map<string, Session>,
  req: IncomingMessage,
  res: ServerResponse,
  origin: string,
  host: string,
): Promise<void> {
  let body: string
  try {
    body = await readPostBody(req)
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      logger.error(error.message)
      if (!res.headersSent) {
        writeJson(res, 413, {
          jsonrpc: '2.0',
          error: { code: -32_600, message: 'Request body too large' },
          id: undefined,
        })
      }
      return
    }
    logger.error(`Error reading POST body: ${errorMessage(error)}`)
    if (!res.headersSent) {
      writeJson(res, 500, {
        jsonrpc: '2.0',
        error: { code: -32_603, message: 'Internal server error' },
        id: undefined,
      })
    }
    return
  }
  try {
    const jsonData = JSON.parse(body)
    const sessionId =
      getRequestHeaderValue(req.headers['mcp-session-id']) || undefined
    const session = sessionId ? sessions.get(sessionId) : undefined
    let transport = session?.transport

    if (!transport && isInitializeRequest(jsonData)) {
      const clientInfo = jsonData.params?.clientInfo
      logger.info(
        `Client connected: ${clientInfo?.name || 'unknown'} v${clientInfo?.version || 'unknown'} from ${origin || host}`,
      )

      const server = createConfiguredServer()
      const newTransport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: id => {
          sessions.set(id, {
            transport: newTransport,
            server,
            lastActivity: Date.now(),
          })
        },
        onsessionclosed: id => {
          destroySession(sessions, id)
        },
      })
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- Transport.onclose is the SDK's documented callback property, not an EventTarget handler.
      newTransport.onclose = () => {
        const id = newTransport.sessionId
        if (id) {
          destroySession(sessions, id)
        }
      }
      transport = newTransport
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- StreamableHTTPServerTransport implements the SDK Transport contract; the cast bridges the SDK's own type split between server and shared transport.
      await server.connect(transport as Transport)
    }

    if (!transport) {
      writeJson(res, 400, {
        jsonrpc: '2.0',
        error: {
          code: -32_000,
          message: 'Bad Request: No valid session. Send initialize first.',
        },
        id: undefined,
      })
      return
    }

    if (sessionId) {
      const activeSession = sessions.get(sessionId)
      if (activeSession) {
        activeSession.lastActivity = Date.now()
      }
    }

    await transport.handleRequest(req, res, jsonData)
  } catch (error) {
    logger.error(`Error processing POST request: ${errorMessage(error)}`)
    if (!res.headersSent) {
      writeJson(res, 500, {
        jsonrpc: '2.0',
        error: { code: -32_603, message: 'Internal server error' },
        id: undefined,
      })
    }
  }
}

// Read and buffer the POST body to a string, capped at MAX_POST_BODY_BYTES.
// Async iteration is modern stream consumption — equivalent to 'data' +
// 'end' without the callback wiring. The running byte count is measured on
// the raw chunks (Buffer.byteLength for the string case) so multibyte
// payloads can't slip past a char-length check; exceeding the cap throws
// PayloadTooLargeError before more memory is committed.
export async function readPostBody(req: IncomingMessage): Promise<string> {
  let body = ''
  let bytes = 0
  for await (const chunk of req) {
    bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
    if (bytes > MAX_POST_BODY_BYTES) {
      req.destroy()
      throw new PayloadTooLargeError(MAX_POST_BODY_BYTES)
    }
    body += typeof chunk === 'string' ? chunk : chunk.toString()
  }
  return body
}

// Iterate sessions, destroying any whose lastActivity is older than
// SESSION_TTL_MS. We materialize the entries up front so deletes inside
// the loop don't perturb iteration.
export function reapIdleSessions(sessions: Map<string, Session>): void {
  const now = Date.now()
  // Snapshot entries so destroySession's deletes don't perturb iteration.
  for (const [id, session] of Array.from(sessions.entries())) {
    if (now - session.lastActivity > SESSION_TTL_MS) {
      logger.info(`Reaping idle session ${id}`)
      destroySession(sessions, id)
    }
  }
}

// Routes a single request: health endpoint, origin validation, OAuth
// metadata exposure, then dispatch by HTTP method to the MCP handlers.
export async function routeRequest(
  sessions: Map<string, Session>,
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
): Promise<void> {
  let url: URL
  try {
    url = new URL(req.url!, `http://localhost:${port}`)
  } catch (error) {
    logger.warn(`Invalid URL in request: ${req.url} - ${errorMessage(error)}`)
    writeJson(res, 400, {
      jsonrpc: '2.0',
      error: { code: -32_000, message: 'Bad Request: Invalid URL' },
      id: undefined,
    })
    return
  }

  // Health endpoint bypasses origin validation so K8s / Docker probes
  // succeed without configuring origins.
  if (url.pathname === '/health') {
    writeJson(res, 200, {
      status: 'healthy',
      service: 'socket-mcp',
      version: VERSION,
      timestamp: new Date().toISOString(),
    })
    return
  }

  const origin = getRequestHeaderValue(req.headers.origin).trim()
  // Strict host matching prevents spoofing via subdomains like
  // "malicious-localhost.evil.com".
  const host = getRequestHeaderValue(req.headers.host).trim()

  if (!validateOriginAndHost(origin, host, port)) {
    logger.warn(
      `Rejected request from invalid origin: ${origin || 'missing'} (host: ${host})`,
    )
    writeJson(res, 403, {
      jsonrpc: '2.0',
      error: { code: -32_000, message: 'Forbidden: Invalid origin' },
      id: undefined,
    })
    return
  }

  writeCorsHeaders(res, origin)

  if (req.method === 'OPTIONS') {
    res.writeHead(200)
    res.end()
    return
  }

  const baseUrl = getRequestBaseUrl(req, port)
  if (
    isOauthEnabled() &&
    url.pathname === OAUTH_PROTECTED_RESOURCE_METADATA_PATH
  ) {
    const oauthMetadata = await loadOAuthMetadata()
    if (!oauthMetadata) {
      writeJson(res, 500, {
        error: 'server_error',
        error_description: 'OAuth metadata is unavailable',
      })
      return
    }
    writeJson(res, 200, buildProtectedResourceMetadata(baseUrl, oauthMetadata))
    return
  }

  if (url.pathname !== '/') {
    res.writeHead(404)
    res.end('Not found')
    return
  }

  patchAcceptHeader(req)

  // A `sktsec_`-prefixed Bearer token authenticates as a Socket API key in
  // both modes; only a non-prefixed token on an OAuth server goes through
  // introspection.
  const hasApiKey = applySocketApiKey(req)
  if (!hasApiKey && isOauthEnabled()) {
    const authResult = await authenticateRequest(
      req,
      res,
      getProtectedResourceMetadataUrl(baseUrl),
    )
    if (!authResult.ok) {
      return
    }
  } else if (!hasApiKey) {
    applyClientApiKey(req)
  }

  if (req.method === 'POST') {
    await handlePost(sessions, req, res, origin, host)
  } else if (req.method === 'GET') {
    await handleGet(sessions, req, res)
  } else if (req.method === 'DELETE') {
    await handleDelete(sessions, req, res)
  } else {
    res.writeHead(405)
    res.end('Method not allowed')
  }
}

// Boot the HTTP MCP server: install the session-reaper, create the
// Node HTTP server, route requests through `routeRequest`, listen, and
// log the start banner.
export function startHttpServer(port: number): void {
  logger.info(`Starting HTTP server on port ${port}`)

  const sessions = new Map<string, Session>()

  const reapInterval = setInterval(() => {
    reapIdleSessions(sessions)
  }, REAP_INTERVAL_MS)
  // Don't keep the process alive just for the reaper.
  reapInterval.unref()

  const httpServer = createServer((req, res) => {
    void routeRequest(sessions, req, res, port)
  })

  httpServer.listen(port, () => {
    logger.info(
      `Socket MCP HTTP server version ${VERSION} started successfully on port ${port}`,
    )
    logger.info(`Connect to: http://localhost:${port}/`)
  })
}
