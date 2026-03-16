#!/usr/bin/env -S node --experimental-strip-types
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import pino from 'pino'
import readline from 'readline'
import { join } from 'path'
import { readFileSync } from 'fs'
import { tmpdir } from 'os'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'

const __dirname = import.meta.dirname

// Extract version from package.json
const packageJson = JSON.parse(readFileSync(join(__dirname, './package.json'), 'utf8'))
const VERSION = packageJson.version || '0.0.1'

// Configure pino logger with cross-platform temp directory
const logger = pino({
  level: 'info',
  transport: {
    targets: [
      {
        target: 'pino/file',
        options: { destination: join(tmpdir(), 'socket-mcp-error.log') },
        level: 'error'
      },
      {
        target: 'pino/file',
        options: { destination: join(tmpdir(), 'socket-mcp.log') },
        level: 'info'
      }
    ]
  }
})

interface OAuthAuthorizationServerMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  introspection_endpoint: string
  [key: string]: unknown
}

type AuthenticatedRequest = IncomingMessage & { auth?: AuthInfo }

// Socket API URL - use localhost when debugging is enabled, otherwise use production
const DEFAULT_SOCKET_API_URL = process.env['SOCKET_DEBUG'] === 'true'
  ? 'http://localhost:8866/v0/purl?alerts=false&compact=false&fixable=false&licenseattrib=false&licensedetails=false'
  : 'https://api.socket.dev/v0/purl?alerts=false&compact=false&fixable=false&licenseattrib=false&licensedetails=false'
const SOCKET_API_URL = process.env['SOCKET_API_URL'] || DEFAULT_SOCKET_API_URL
const SOCKET_OAUTH_ISSUER = process.env['SOCKET_OAUTH_ISSUER'] || ''
const SOCKET_OAUTH_INTROSPECTION_CLIENT_ID =
  process.env['SOCKET_OAUTH_INTROSPECTION_CLIENT_ID'] || ''
const SOCKET_OAUTH_INTROSPECTION_CLIENT_SECRET =
  process.env['SOCKET_OAUTH_INTROSPECTION_CLIENT_SECRET'] || ''
const SOCKET_OAUTH_REQUIRED_SCOPES = (
  process.env['SOCKET_OAUTH_REQUIRED_SCOPES'] || 'packages:list'
)
  .split(/\s+/u)
  .map(scope => scope.trim())
  .filter(Boolean)
const TRUST_PROXY = process.env['TRUST_PROXY'] === 'true'
const OAUTH_WELL_KNOWN_PATH = '/.well-known/oauth-authorization-server'
const OAUTH_PROTECTED_RESOURCE_METADATA_PATH =
  '/.well-known/oauth-protected-resource'

// Function to get API key interactively (only for HTTP mode)
async function getApiKeyInteractively (): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr
  })

  const apiKey = await new Promise<string>((resolve) => {
    rl.question('Please enter your Socket API key: ', (answer: string | PromiseLike<string>) => {
      rl.close()
      resolve(answer)
    })
  })

  if (!apiKey) {
    logger.error('No API key provided')
    process.exit(1)
  }

  return apiKey
}

// Initialize API key
let SOCKET_API_KEY = process.env['SOCKET_API_KEY'] || ''

// Build Socket API request headers with the provided access token.
function buildSocketHeaders (accessToken?: string): Record<string, string> {
  return {
    'user-agent': `socket-mcp/${VERSION}`,
    accept: 'application/x-ndjson',
    'content-type': 'application/json',
    ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {})
  }
}

function splitScopes (scope: unknown): string[] {
  if (typeof scope !== 'string') {
    return []
  }

  return scope
    .split(/\s+/u)
    .map(value => value.trim())
    .filter(Boolean)
}

function getRequestHeaderValue (header: string | string[] | undefined): string {
  if (Array.isArray(header)) {
    return header[0] || ''
  }

  return header || ''
}

function getForwardedHeaderValue (header: string | string[] | undefined): string {
  return getRequestHeaderValue(header)
    .split(',', 1)[0]
    ?.trim() || ''
}

function getRequestBaseUrl (req: IncomingMessage, fallbackPort: number): URL {
  const forwardedProto = TRUST_PROXY
    ? getForwardedHeaderValue(req.headers['x-forwarded-proto']).toLowerCase()
    : ''
  const forwardedHost = TRUST_PROXY
    ? getForwardedHeaderValue(req.headers['x-forwarded-host'])
    : ''
  const host = forwardedHost || getRequestHeaderValue(req.headers.host).trim() || `localhost:${fallbackPort}`
  const socketWithTls = req.socket as { encrypted?: boolean }
  const protocol = forwardedProto === 'https' || forwardedProto === 'http'
    ? forwardedProto
    : (socketWithTls.encrypted ? 'https' : 'http')

  return new URL(`${protocol}://${host}/`)
}

function parseJsonObject (
  responseText: string,
  context: string
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(responseText)

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected a JSON object')
    }

    return parsed as Record<string, unknown>
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${context} returned invalid JSON: ${message}`)
  }
}

function getProtectedResourceMetadataUrl (baseUrl: URL): string {
  return new URL(OAUTH_PROTECTED_RESOURCE_METADATA_PATH, baseUrl).href
}

function buildProtectedResourceMetadata (
  baseUrl: URL,
  oauthMetadata: OAuthAuthorizationServerMetadata
): Record<string, unknown> {
  return {
    resource: new URL('/', baseUrl).href,
    authorization_servers: [oauthMetadata.issuer],
    scopes_supported: SOCKET_OAUTH_REQUIRED_SCOPES,
    resource_name: 'Socket MCP Server'
  }
}

function writeJson (
  res: ServerResponse,
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    ...headers
  })
  res.end(JSON.stringify(body))
}

function writeOAuthError (
  res: ServerResponse,
  statusCode: number,
  errorCode: string,
  message: string,
  resourceMetadataUrl?: string
): void {
  const authenticateValue = resourceMetadataUrl
    ? `Bearer error="${errorCode}", error_description="${message}", resource_metadata="${resourceMetadataUrl}"`
    : `Bearer error="${errorCode}", error_description="${message}"`

  writeJson(
    res,
    statusCode,
    {
      error: errorCode,
      error_description: message
    },
    { 'WWW-Authenticate': authenticateValue }
  )
}

const useHttp = process.env['MCP_HTTP_MODE'] === 'true' || process.argv.includes('--http')
const port = parseInt(process.env['MCP_PORT'] || '3000', 10)
const hasAnyOAuthConfig = Boolean(
  SOCKET_OAUTH_ISSUER ||
  SOCKET_OAUTH_INTROSPECTION_CLIENT_ID ||
  SOCKET_OAUTH_INTROSPECTION_CLIENT_SECRET
)
const oauthEnabled = useHttp && Boolean(
  SOCKET_OAUTH_ISSUER &&
  SOCKET_OAUTH_INTROSPECTION_CLIENT_ID &&
  SOCKET_OAUTH_INTROSPECTION_CLIENT_SECRET
)

let oauthMetadataPromise: Promise<OAuthAuthorizationServerMetadata> | undefined

async function loadOAuthMetadata (): Promise<OAuthAuthorizationServerMetadata | null> {
  if (!oauthEnabled) {
    return null
  }

  if (!oauthMetadataPromise) {
    const metadataPromise = (async () => {
      const issuerUrl = new URL(SOCKET_OAUTH_ISSUER)
      const response = await fetch(new URL(OAUTH_WELL_KNOWN_PATH, issuerUrl))
      const responseText = await response.text()

      if (!response.ok) {
        throw new Error(`OAuth metadata discovery failed with status ${response.status}: ${responseText}`)
      }

      const metadata = parseJsonObject(responseText, 'OAuth metadata discovery')

      for (const field of [
        'issuer',
        'authorization_endpoint',
        'token_endpoint',
        'introspection_endpoint'
      ] as const) {
        if (typeof metadata[field] !== 'string' || !metadata[field]) {
          throw new Error(`OAuth metadata missing required field: ${field}`)
        }
      }

      return metadata as OAuthAuthorizationServerMetadata
    })()

    const retryableMetadataPromise = metadataPromise.catch((error) => {
      if (oauthMetadataPromise === retryableMetadataPromise) {
        oauthMetadataPromise = undefined
      }

      throw error
    })

    oauthMetadataPromise = retryableMetadataPromise
  }

  return await oauthMetadataPromise
}

async function verifyAccessToken (token: string): Promise<AuthInfo | null> {
  const oauthMetadata = await loadOAuthMetadata()
  if (!oauthMetadata) {
    throw new Error('OAuth is not configured for this server')
  }

  const response = await fetch(oauthMetadata.introspection_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${SOCKET_OAUTH_INTROSPECTION_CLIENT_ID}:${SOCKET_OAUTH_INTROSPECTION_CLIENT_SECRET}`).toString('base64')}`
    },
    body: new URLSearchParams({ token }).toString()
  })
  const responseText = await response.text()

  if (!response.ok) {
    throw new Error(`Token introspection failed with status ${response.status}: ${responseText}`)
  }

  const introspection = parseJsonObject(responseText, 'Token introspection')
  if (!introspection['active']) {
    return null
  }

  const expiresAt = typeof introspection['exp'] === 'number'
    ? introspection['exp']
    : Number(introspection['exp'])

  return {
    token,
    clientId: typeof introspection['client_id'] === 'string'
      ? introspection['client_id']
      : 'unknown',
    scopes: splitScopes(introspection['scope']),
    ...(Number.isFinite(expiresAt) ? { expiresAt } : {}),
    extra: introspection
  }
}

async function authenticateRequest (
  req: AuthenticatedRequest,
  res: ServerResponse,
  resourceMetadataUrl: string
): Promise<{ ok: false } | { ok: true, authInfo: AuthInfo }> {
  const authHeader = getRequestHeaderValue(req.headers.authorization).trim()
  if (!authHeader) {
    writeOAuthError(res, 401, 'invalid_request', 'Missing Authorization header', resourceMetadataUrl)
    return { ok: false }
  }

  const [type, token] = authHeader.split(/\s+/u)
  if ((type || '').toLowerCase() !== 'bearer' || !token) {
    writeOAuthError(
      res,
      401,
      'invalid_request',
      "Invalid Authorization header format, expected 'Bearer TOKEN'",
      resourceMetadataUrl
    )
    return { ok: false }
  }

  let authInfo: AuthInfo | null
  try {
    authInfo = await verifyAccessToken(token)
  } catch (error) {
    logger.error(`Token verification failed: ${error instanceof Error ? error.message : String(error)}`)
    writeJson(res, 500, {
      error: 'server_error',
      error_description: 'Token verification failed'
    })
    return { ok: false }
  }

  if (!authInfo) {
    writeOAuthError(res, 401, 'invalid_token', 'Invalid or expired token', resourceMetadataUrl)
    return { ok: false }
  }

  if (typeof authInfo.expiresAt === 'number' &&
    authInfo.expiresAt < Date.now() / 1000) {
    writeOAuthError(res, 401, 'invalid_token', 'Token has expired', resourceMetadataUrl)
    return { ok: false }
  }

  const missingScopes = SOCKET_OAUTH_REQUIRED_SCOPES.filter(scope => !authInfo.scopes.includes(scope))
  if (missingScopes.length > 0) {
    writeOAuthError(
      res,
      403,
      'insufficient_scope',
      `Missing required scopes: ${missingScopes.join(', ')}`,
      resourceMetadataUrl
    )
    return { ok: false }
  }

  req.auth = authInfo
  return {
    ok: true,
    authInfo
  }
}

/** Creates a configured McpServer with tools. Used for stdio (single instance) and HTTP (one per session). */
function createConfiguredServer (): McpServer {
  const srv = new McpServer({ name: 'socket', version: VERSION })
  srv.registerTool(
    'depscore',
    {
      title: 'Dependency Score Tool',
      description: "Get the dependency score of packages with the `depscore` tool from Socket. Use 'unknown' for version if not known. Use this tool to scan dependencies for their quality and security on existing code or when code is generated. Stop generating code and ask the user how to proceed when any of the scores are low. When checking dependencies, make sure to also check the imports in the code, not just the manifest files (pyproject.toml, package.json, etc).",
      inputSchema: {
        packages: z.array(z.object({
          ecosystem: z.string().describe('The package ecosystem (e.g., npm, pypi, gem, golang, maven, nuget, cargo)').default('npm'),
          depname: z.string().describe('The name of the dependency'),
          version: z.string().describe("The version of the dependency, use 'unknown' if not known").default('unknown'),
        })).describe('Array of packages to check'),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ packages }, extra) => {
      logger.info(`Received request for ${packages.length} packages`)
      const accessToken = extra.authInfo?.token || SOCKET_API_KEY
      if (!accessToken) {
        const errorMsg = 'Authentication is required. Configure SOCKET_API_KEY for stdio mode or connect through OAuth-enabled HTTP mode.'
        logger.error(errorMsg)
        return {
          content: [{ type: 'text', text: errorMsg }],
          isError: true
        }
      }

      // Build components array for the API request
      const components = packages.map((pkg: { ecosystem?: string; depname: string; version?: string }) => {
        const cleanedVersion = (pkg.version ?? 'unknown').replace(/[\^~]/g, '') // Remove ^ and ~ from version
        const ecosystem = pkg.ecosystem ?? 'npm'
        let purl: string
        if (cleanedVersion === '1.0.0' || cleanedVersion === 'unknown' || !cleanedVersion) {
          purl = `pkg:${ecosystem}/${pkg.depname}`
        } else {
          logger.info(`Using version ${cleanedVersion} for ${pkg.depname}`)
          purl = `pkg:${ecosystem}/${pkg.depname}@${cleanedVersion}`
        }
        return { purl }
      })

      try {
      // Make a POST request to the Socket API with all packages
        const response = await fetch(SOCKET_API_URL, {
          method: 'POST',
          headers: buildSocketHeaders(accessToken),
          body: JSON.stringify({ components })
        })

        const responseText = await response.text()

        if (response.status === 401) {
          const errorMsg = `Socket authentication failed [401]. Re-authenticate and retry. ${responseText}`
          logger.error(errorMsg)
          return {
            content: [{ type: 'text', text: errorMsg }],
            isError: true
          }
        }

        if (response.status === 403) {
          const errorMsg = `Socket denied access [403]. Re-authenticate with the correct organization or repository permissions and retry. ${responseText}`
          logger.error(errorMsg)
          return {
            content: [{ type: 'text', text: errorMsg }],
            isError: true
          }
        }

        if (response.status !== 200) {
          const errorMsg = `Error processing packages: [${response.status}] ${responseText}`
          logger.error(errorMsg)
          return {
            content: [{ type: 'text', text: errorMsg }],
            isError: true
          }
        } else if (!responseText.trim()) {
          const errorMsg = 'No packages were found.'
          logger.error(errorMsg)
          return {
            content: [{ type: 'text', text: errorMsg }],
            isError: true
          }
        }

        try {
        // Handle NDJSON (multiple JSON objects, one per line)
          const results: string[] = []

          if ((response.headers.get('content-type') || '').includes('x-ndjson')) {
            const jsonLines = responseText.split('\n')
              .filter(line => line.trim())
              .map(line => JSON.parse(line))

            if (!jsonLines.length) {
              const errorMsg = 'No valid JSON objects found in NDJSON response'
              return {
                content: [{ type: 'text', text: errorMsg }],
                isError: true
              }
            }

            // Process each result
            for (const jsonData of jsonLines) {
              const purl: string = `pkg:${jsonData.type || 'unknown'}/${jsonData.name || 'unknown'}@${jsonData.version || 'unknown'}`
              if (jsonData.score && jsonData.score.overall !== undefined) {
                const scoreEntries = Object.entries(jsonData.score)
                  .filter(([key]) => key !== 'overall' && key !== 'uuid')
                  .map(([key, value]) => {
                    const numValue = Number(value)
                    const displayValue = numValue <= 1 ? Math.round(numValue * 100) : numValue
                    return `${key}: ${displayValue}`
                  })
                  .join(', ')

                results.push(`${purl}: ${scoreEntries}`)
              } else {
                results.push(`${purl}: No score found`)
              }
            }
          } else {
            const jsonData = JSON.parse(responseText)
            const purl: string = `pkg:${jsonData.type || 'unknown'}/${jsonData.name || 'unknown'}@${jsonData.version || 'unknown'}`
            if (jsonData.score && jsonData.score.overall !== undefined) {
              const scoreEntries = Object.entries(jsonData.score)
                .filter(([key]) => key !== 'overall' && key !== 'uuid')
                .map(([key, value]) => {
                  const numValue = Number(value)
                  const displayValue = numValue <= 1 ? Math.round(numValue * 100) : numValue
                  return `${key}: ${displayValue}`
                })
                .join(', ')

              results.push(`${purl}: ${scoreEntries}`)
            } else {
              results.push(`${purl}: No score found`)
            }
          }

          return {
            content: [
              {
                type: 'text',
                text: results.length > 0
                  ? `Dependency scores:\n${results.join('\n')}`
                  : 'No scores found for the provided packages'
              }
            ]
          }
        } catch (e) {
          const error = e as Error
          const errorMsg = `JSON parsing error: ${error.message} -- Response: ${responseText}`
          logger.error(errorMsg)
          return {
            content: [{ type: 'text', text: 'Error parsing response from Socket API' }],
            isError: true
          }
        }
      } catch (e) {
        const error = e as Error
        const errorMsg = `Error processing packages: ${error.message}`
        logger.error(errorMsg)
        return {
          content: [{ type: 'text', text: 'Error connecting to Socket API' }],
          isError: true
        }
      }
    }
  )
  return srv
}

if (useHttp && hasAnyOAuthConfig && !oauthEnabled) {
  logger.error('Incomplete OAuth configuration for HTTP mode. Set SOCKET_OAUTH_ISSUER, SOCKET_OAUTH_INTROSPECTION_CLIENT_ID, and SOCKET_OAUTH_INTROSPECTION_CLIENT_SECRET together.')
  process.exit(1)
}

// Validate API key - in stdio mode, we can't prompt interactively
if (!SOCKET_API_KEY && !(useHttp && oauthEnabled)) {
  if (useHttp) {
    // In HTTP mode, we can prompt for the API key
    logger.error('SOCKET_API_KEY environment variable is not set')
    SOCKET_API_KEY = await getApiKeyInteractively()
  } else {
    // In stdio mode, we must have the API key as an environment variable
    logger.error('SOCKET_API_KEY environment variable is required in stdio mode')
    logger.error('Please set the SOCKET_API_KEY environment variable and try again')
    process.exit(1)
  }
}

if (oauthEnabled) {
  try {
    await loadOAuthMetadata()
    logger.info(`Enabled OAuth-backed MCP auth with issuer ${SOCKET_OAUTH_ISSUER}`)
  } catch (error) {
    logger.error(`Failed to initialize OAuth metadata: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

if (useHttp) {
  // HTTP mode with Server-Sent Events
  logger.info(`Starting HTTP server on port ${port}`)

  // Per-session transports and servers: each client gets its own transport+server pair.
  // Both must persist for the session lifetime; storing the server prevents GC from
  // reclaiming it before subsequent RPC calls.
  interface Session { transport: StreamableHTTPServerTransport; server: McpServer; lastActivity: number }
  const sessions = new Map<string, Session>()

  /** Tear down a session by id, closing transport and server. Safe to call multiple times. */
  function destroySession (id: string): void {
    const s = sessions.get(id)
    if (!s) return
    sessions.delete(id)
    try { s.transport.close() } catch {}
    s.server.close().catch(() => {})
    logger.info(`Session ${id} destroyed`)
  }

  // Reap idle sessions every 60 s. Sessions unused for 30 min are removed.
  const SESSION_TTL_MS = 30 * 60 * 1000
  const reapInterval = setInterval(() => {
    const now = Date.now()
    for (const [id, session] of sessions.entries()) {
      if (now - session.lastActivity > SESSION_TTL_MS) {
        logger.info(`Reaping idle session ${id}`)
        destroySession(id)
      }
    }
  }, 60_000)
  reapInterval.unref() // don't keep the process alive just for the reaper

  const httpServer = createServer(async (req, res) => {
    const authenticatedReq = req as AuthenticatedRequest

    // Parse URL first to check for health endpoint
    let url: URL
    try {
      url = new URL(req.url!, `http://localhost:${port}`)
    } catch (error) {
      logger.warn(`Invalid URL in request: ${req.url} - ${error}`)
      writeJson(res, 400, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: Invalid URL' },
        id: null
      })
      return
    }

    // Health check endpoint for K8s/Docker - bypass origin validation
    if (url.pathname === '/health') {
      writeJson(res, 200, {
        status: 'healthy',
        service: 'socket-mcp',
        version: VERSION,
        timestamp: new Date().toISOString()
      })
      return
    }

    // Validate Origin header as required by MCP spec (for non-health endpoints)
    const origin = getRequestHeaderValue(req.headers.origin).trim()

    // Check if origin is from localhost (any port) - safe for local development
    const isLocalhostOrigin = (originUrl: string): boolean => {
      try {
        const originValue = new URL(originUrl)
        return originValue.hostname === 'localhost' || originValue.hostname === '127.0.0.1'
      } catch {
        return false
      }
    }

    const allowedOrigins = [
      'https://mcp.socket.dev',
      'https://mcp.socket-staging.dev'
    ]

    // Check if request is from localhost (for same-origin requests that don't send Origin header)
    // Use strict matching to prevent spoofing via subdomains like "malicious-localhost.evil.com"
    const host = getRequestHeaderValue(req.headers.host).trim()

    // Extract hostnames from allowedOrigins for Host header validation
    const allowedHosts = allowedOrigins.map(o => new URL(o).hostname)

    const isAllowedHost = host === `localhost:${port}` ||
                            host === `127.0.0.1:${port}` ||
                            host === 'localhost' ||
                            host === '127.0.0.1' ||
                            allowedHosts.includes(host)

    // Allow requests:
    // 1. With Origin header from localhost (any port) or production domains
    // 2. Without Origin header if they're from localhost or allowed domains (same-origin requests)
    const isValidOrigin = origin
      ? (isLocalhostOrigin(origin) || allowedOrigins.includes(origin))
      : isAllowedHost

    if (!isValidOrigin) {
      logger.warn(`Rejected request from invalid origin: ${origin || 'missing'} (host: ${host})`)
      writeJson(res, 403, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Forbidden: Invalid origin' },
        id: null
      })
      return
    }

    // Set CORS headers for valid origins (only needed for cross-origin requests)
    // Mcp-Session-Id must be exposed for browser-based MCP clients
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, Mcp-Session-Id')
      res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, WWW-Authenticate')
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(200)
      res.end()
      return
    }

    const baseUrl = getRequestBaseUrl(req, port)
    if (oauthEnabled && url.pathname === OAUTH_PROTECTED_RESOURCE_METADATA_PATH) {
      const oauthMetadata = await loadOAuthMetadata()
      if (!oauthMetadata) {
        writeJson(res, 500, {
          error: 'server_error',
          error_description: 'OAuth metadata is unavailable'
        })
        return
      }

      writeJson(res, 200, buildProtectedResourceMetadata(baseUrl, oauthMetadata))
      return
    }

    if (url.pathname === '/') {
      // Ensure Accept header includes required MIME types for MCP Streamable HTTP spec.
      // Some clients (e.g. Cursor) may not send these, causing the SDK to reject with 406.
      // We patch both req.headers and rawHeaders because @hono/node-server reads rawHeaders.
      const accept = req.headers.accept || ''
      if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
        const requiredAccept = 'application/json, text/event-stream'
        req.headers.accept = requiredAccept
        const idx = req.rawHeaders.findIndex(h => h.toLowerCase() === 'accept')
        if (idx !== -1) {
          req.rawHeaders[idx + 1] = requiredAccept
        } else {
          req.rawHeaders.push('Accept', requiredAccept)
        }
      }

      if (oauthEnabled) {
        const authResult = await authenticateRequest(
          authenticatedReq,
          res,
          getProtectedResourceMetadataUrl(baseUrl)
        )

        if (!authResult.ok) {
          return
        }
      }

      if (req.method === 'POST') {
        // Buffer the body, then pass it as parsedBody so hono doesn't re-read the consumed stream.
        let body = ''
        req.on('data', (chunk: string) => { body += chunk })
        req.on('end', async () => {
          try {
            const jsonData = JSON.parse(body)
            const sessionId = getRequestHeaderValue(req.headers['mcp-session-id']) || undefined
            const session = sessionId ? sessions.get(sessionId) : undefined
            let transport = session?.transport

            if (!transport && isInitializeRequest(jsonData)) {
              const clientInfo = jsonData.params?.clientInfo
              logger.info(`Client connected: ${clientInfo?.name || 'unknown'} v${clientInfo?.version || 'unknown'} from ${origin || host}`)

              const server = createConfiguredServer()
              const newTransport = new StreamableHTTPServerTransport({
                enableJsonResponse: true,
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (id) => {
                  sessions.set(id, { transport: newTransport, server, lastActivity: Date.now() })
                },
                onsessionclosed: (id) => { destroySession(id) }
              })
              newTransport.onclose = () => {
                const id = newTransport.sessionId
                if (id) destroySession(id)
              }
              transport = newTransport
              await server.connect(transport as Transport)
            }

            if (!transport) {
              writeJson(res, 400, {
                jsonrpc: '2.0',
                error: { code: -32000, message: 'Bad Request: No valid session. Send initialize first.' },
                id: null
              })
              return
            }

            // Touch session activity for TTL tracking
            if (sessionId) {
              const activeSession = sessions.get(sessionId)
              if (activeSession) activeSession.lastActivity = Date.now()
            }

            await transport.handleRequest(authenticatedReq, res, jsonData)
          } catch (error) {
            logger.error(`Error processing POST request: ${error}`)
            if (!res.headersSent) {
              writeJson(res, 500, {
                jsonrpc: '2.0',
                error: { code: -32603, message: 'Internal server error' },
                id: null
              })
            }
          }
        })
      } else if (req.method === 'GET') {
        const sessionId = getRequestHeaderValue(req.headers['mcp-session-id']) || undefined
        const session = sessionId ? sessions.get(sessionId) : undefined
        if (!session) {
          writeJson(res, 404, {
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Not Found: Invalid or expired session. Re-initialize.' },
            id: null
          })
          return
        }
        try {
          session.lastActivity = Date.now()
          await session.transport.handleRequest(authenticatedReq, res)
        } catch (error) {
          logger.error(`Error processing GET request: ${error}`)
          if (!res.headersSent) {
            writeJson(res, 500, {
              jsonrpc: '2.0',
              error: { code: -32603, message: 'Internal server error' },
              id: null
            })
          }
        }
      } else if (req.method === 'DELETE') {
        const sessionId = getRequestHeaderValue(req.headers['mcp-session-id']) || undefined
        const transport = sessionId ? sessions.get(sessionId)?.transport : undefined
        if (!transport) {
          writeJson(res, 404, {
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Not Found: Invalid or expired session.' },
            id: null
          })
          return
        }
        try {
          await transport.handleRequest(authenticatedReq, res)
        } catch (error) {
          logger.error(`Error processing DELETE request: ${error}`)
          if (!res.headersSent) {
            writeJson(res, 500, {
              jsonrpc: '2.0',
              error: { code: -32603, message: 'Internal server error' },
              id: null
            })
          }
        }
      } else {
        res.writeHead(405)
        res.end('Method not allowed')
      }
    } else {
      res.writeHead(404)
      res.end('Not found')
    }
  })

  httpServer.listen(port, () => {
    logger.info(`Socket MCP HTTP server version ${VERSION} started successfully on port ${port}`)
    logger.info(`Connect to: http://localhost:${port}/`)
  })
} else {
  // Stdio mode (default)
  logger.info('Starting in stdio mode')
  const server = createConfiguredServer()
  const transport = new StdioServerTransport()
  server.connect(transport)
    .then(() => {
      logger.info(`Socket MCP server version ${VERSION} started successfully`)
    })
    .catch((error: Error) => {
      logger.error(`Failed to start Socket MCP server: ${error.message}`)
      process.exit(1)
    })
}
