// HTTP transport module: request routing, the post-body size guard, and the
// per-request auth handoff — the cohesive request path that reads
// top-to-bottom. Origin/CORS/Accept-header validation lives in http-origin.ts.
import { toNodeHandler } from '@modelcontextprotocol/node'
import type { NodeMcpRequestHandler } from '@modelcontextprotocol/node'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { errorMessage } from '@socketsecurity/lib/errors/message'
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
  isOauthEnabled,
  loadOAuthMetadata,
  OAUTH_PROTECTED_RESOURCE_METADATA_PATH,
} from './oauth.ts'
import type { AuthenticatedRequest } from './oauth.ts'
import { VERSION } from './version.ts'

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
  // `authHeader` is trimmed and non-empty, so splitting on whitespace always
  // yields a non-empty first element.
  const [type, token] = authHeader.split(/\s+/u)
  if (type!.toLowerCase() !== 'bearer' || !token) {
    return
  }
  req.auth = { token, clientId: 'socket-api-key', scopes: [] }
}

// Build one request's last-resort rejection handler. A `routeRequest`
// rejection would otherwise be unhandled, which hangs the client and ends the
// process under Node's default rejection policy — one request must never take
// the server down. Once headers are out the status is already committed, so
// the only move left is closing the response.
export function createRouteFailureHandler(
  res: ServerResponse,
): (error: unknown) => void {
  return error => {
    logger.error(`Unhandled request failure: ${errorMessage(error)}`)
    if (!res.headersSent) {
      writeJson(res, 500, {
        jsonrpc: '2.0',
        error: { code: -32_603, message: 'Internal server error' },
        id: undefined,
      })
      return
    }
    res.end()
  }
}

// The Node adapter's `onerror` sink. Reached when the adapter itself fails
// around an exchange — a mid-response socket abort, a transport-level write
// error — rather than inside a tool.
export function handleMcpAdapterError(error: unknown): void {
  logger.error(`MCP adapter failed: ${errorMessage(error)}`)
}

// The MCP handler's `onerror` sink. Reached when serving one exchange throws
// past the per-request handling in `handleMcpRequest`.
export function handleMcpHandlerError(error: unknown): void {
  logger.error(`MCP request failed: ${errorMessage(error)}`)
}

// Hand one request to the MCP handler. The adapter reads the request stream
// itself and enforces no size limit of its own, so a body-bearing method is
// buffered here under MAX_POST_BODY_BYTES and handed over pre-parsed — with a
// parsed body the adapter reads nothing from `req`. Per-request auth rides on
// `req.auth`, which the adapter forwards to handlers as `ctx.http.authInfo`.
export async function handleMcpRequest(
  mcpHandler: NodeMcpRequestHandler,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let parsedBody: unknown
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    let body: string
    try {
      body = await readPostBody(req)
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        logger.error(error.message)
        if (!res.headersSent) {
          // The client is still uploading, so the rest of the body would
          // arrive with nobody reading it. Announce the close, write the 413,
          // and only then drop the request stream — destroying it any earlier
          // kills the socket before the status reaches the client.
          writeJson(
            res,
            413,
            {
              jsonrpc: '2.0',
              error: { code: -32_600, message: 'Request body too large' },
              id: undefined,
            },
            { Connection: 'close' },
          )
          res.on('finish', () => {
            req.destroy()
          })
        }
        return
      }
      logger.error(`Error reading request body: ${errorMessage(error)}`)
      if (!res.headersSent) {
        writeJson(res, 500, {
          jsonrpc: '2.0',
          error: { code: -32_603, message: 'Internal server error' },
          id: undefined,
        })
      }
      return
    }
    if (body) {
      try {
        parsedBody = JSON.parse(body)
      } catch (error) {
        logger.error(`Malformed JSON in request body: ${errorMessage(error)}`)
        writeJson(res, 400, {
          jsonrpc: '2.0',
          error: { code: -32_700, message: 'Parse error' },
          id: undefined,
        })
        return
      }
    }
  }
  // The adapter's request shape types `method` and `url` as plain optional
  // strings while @types/node types them `string | undefined`, which
  // `exactOptionalPropertyTypes` refuses. Node always sets both on a server
  // request, so re-state them rather than widen the adapter's contract.
  const mcpReq = Object.assign(req, {
    method: req.method ?? 'GET',
    url: req.url ?? '/',
  })
  try {
    await mcpHandler(mcpReq, res, parsedBody)
  } catch (error) {
    logger.error(
      `Error processing ${req.method} request: ${errorMessage(error)}`,
    )
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
// payloads can't slip past a char-length check; exceeding the cap stops the
// read and throws PayloadTooLargeError before more memory is committed.
//
// `destroyOnReturn: false` keeps the socket alive when the loop breaks early.
// Node's default async iterator destroys the stream on `break`, which tears
// down the connection before the caller can write its 413 — the client would
// see a socket error instead of the status. The caller owns the teardown and
// destroys the request once the response has flushed.
export async function readPostBody(req: IncomingMessage): Promise<string> {
  let body = ''
  let bytes = 0
  let overLimit = false
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
    if (bytes > MAX_POST_BODY_BYTES) {
      overLimit = true
      break
    }
    body += typeof chunk === 'string' ? chunk : chunk.toString()
  }
  if (overLimit) {
    throw new PayloadTooLargeError(MAX_POST_BODY_BYTES)
  }
  return body
}

// Routes a single request: health endpoint, origin validation, OAuth
// metadata exposure, then dispatch to the MCP handler.
export async function routeRequest(
  mcpHandler: NodeMcpRequestHandler,
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
    // Discovery rejects when the issuer is unreachable or serves no usable
    // metadata. Answering from the catch keeps a down issuer from becoming an
    // unhandled rejection, which would hang the request and take the process
    // with it.
    try {
      await loadOAuthMetadata()
    } catch (error) {
      logger.error(`OAuth metadata discovery failed: ${errorMessage(error)}`)
      writeJson(res, 500, {
        error: 'server_error',
        error_description: 'OAuth metadata is unavailable',
      })
      return
    }
    writeJson(res, 200, buildProtectedResourceMetadata(baseUrl))
    return
  }

  if (url.pathname !== '/') {
    res.writeHead(404)
    res.end('Not found')
    return
  }

  patchAcceptHeader(req)

  // On an OAuth-enabled deployment, OAuth is the only way in: every Bearer
  // token goes through introspection, expiry, audience, and scope checks. A
  // token prefix is not authentication, so a raw Socket API key is accepted
  // only when OAuth is off.
  if (isOauthEnabled()) {
    const authResult = await authenticateRequest(req, res, baseUrl)
    if (!authResult.ok) {
      return
    }
  } else {
    applyClientApiKey(req)
  }

  // GET and DELETE reach the MCP handler too: it answers the 2025-era session
  // operations with its own 405 rather than a hand-rolled session table.
  if (
    req.method === 'DELETE' ||
    req.method === 'GET' ||
    req.method === 'POST'
  ) {
    await handleMcpRequest(mcpHandler, req, res)
  } else {
    res.writeHead(405)
    res.end('Method not allowed')
  }
}

// Boot the HTTP MCP server: build the MCP handler, create the Node HTTP
// server, route requests through `routeRequest`, listen, and log the start
// banner.
export function startHttpServer(port: number): void {
  logger.info(`Starting HTTP server on port ${port}`)

  // One handler for the process. It calls `createConfiguredServer` per
  // exchange and closes the instance afterwards, so the factory — not a
  // shared instance — is what gets passed in. Leaving `legacy` unset keeps
  // its default stateless serving, so 2025-era clients are served alongside
  // 2026-era ones.
  const mcpHandler = toNodeHandler(
    createMcpHandler(createConfiguredServer, {
      onerror: handleMcpHandlerError,
    }),
    { onerror: handleMcpAdapterError },
  )

  const httpServer = createServer((req, res) => {
    routeRequest(mcpHandler, req, res, port).catch(
      createRouteFailureHandler(res),
    )
  })

  httpServer.listen(port, () => {
    logger.info(
      `Socket MCP HTTP server version ${VERSION} started successfully on port ${port}`,
    )
    logger.info(`Connect to: http://localhost:${port}/`)
  })
}
