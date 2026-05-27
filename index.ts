#!/usr/bin/env -S node --experimental-strip-types
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { buildPurl } from './lib/purl.ts'
import { deduplicateArtifacts } from './lib/artifacts.ts'
import { fetchFileList } from './lib/files.ts'
import { fetchBlob, type BlobResult } from './lib/blob.ts'
import { fetchOrganizations } from './lib/organizations.ts'
import { fetchAlerts } from './lib/alerts.ts'
import { fetchThreatFeed } from './lib/threatFeed.ts'
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
const LOG_LEVEL = process.env['LOG_LEVEL'] || 'info'
const PRETTY_LOGS = process.env['SOCKET_LOG_PRETTY'] === 'true'

interface PinoTarget { target: string, options: Record<string, unknown>, level: string }
const logTargets: PinoTarget[] = [
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
if (PRETTY_LOGS) {
  // Stream to stderr — stdout is reserved for MCP protocol traffic in stdio mode.
  logTargets.push({
    target: 'pino-pretty',
    options: { destination: 2, colorize: true, translateTime: 'SYS:HH:MM:ss.l', singleLine: false },
    level: LOG_LEVEL
  })
}
const logger = pino({ level: LOG_LEVEL, transport: { targets: logTargets } })

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
// Socket API base URL - used by endpoints like /v0/purl/file-list/{purl}.
// Mirrors SOCKET_API_URL's localhost/prod switch via SOCKET_DEBUG.
const DEFAULT_SOCKET_API_BASE_URL = process.env['SOCKET_DEBUG'] === 'true'
  ? 'http://localhost:8866'
  : 'https://api.socket.dev'
const SOCKET_API_BASE_URL = process.env['SOCKET_API_BASE_URL'] || DEFAULT_SOCKET_API_BASE_URL
const SOCKET_BLOB_URL = process.env['SOCKET_BLOB_URL'] || 'https://socketusercontent.com'
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

// User agent for socket.dev (file manifest) and socketusercontent.com (file blobs).
// These hosts sit behind Cloudflare and reject server-style UAs with a JS challenge,
// so we send a browser UA. Override via SOCKET_BROWSER_USER_AGENT.
const BROWSER_USER_AGENT = process.env['SOCKET_BROWSER_USER_AGENT'] ||
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'

// Internal UA for authenticated calls to socket.dev's file-list endpoint.
// Override via SOCKET_INTERNAL_USER_AGENT.
const INTERNAL_USER_AGENT = process.env['SOCKET_INTERNAL_USER_AGENT'] || 'socket-internal-tool/1.0'

// Optional WAF/Cloudflare bypass header sent on every socket.dev and
// socketusercontent.com request. Override via SOCKET_BYPASS_HEADER_NAME /
// SOCKET_BYPASS_HEADER_VALUE; leave the value empty to disable.
const SOCKET_BYPASS_HEADER_NAME = process.env['SOCKET_BYPASS_HEADER_NAME'] || 'tuckner-mcp-test'
const SOCKET_BYPASS_HEADER_VALUE = process.env['SOCKET_BYPASS_HEADER_VALUE'] || '2ff2101a81684e643bb5ed2c7246fa80'
const BYPASS_HEADERS: Record<string, string> = SOCKET_BYPASS_HEADER_VALUE
  ? { [SOCKET_BYPASS_HEADER_NAME]: SOCKET_BYPASS_HEADER_VALUE }
  : {}

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

// Process-wide LRU blob cache keyed by content-addressed hash. Survives across
// stateless HTTP requests (each request gets a fresh McpServer) so repeated
// reads/greps of the same file skip the socketusercontent fetch. Size is
// approximated by text byte length; cap via SOCKET_BLOB_CACHE_BYTES (default 64 MB).
const BLOB_CACHE_MAX_BYTES = (() => {
  const raw = process.env['SOCKET_BLOB_CACHE_BYTES']
  if (!raw) return 64 * 1024 * 1024
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 64 * 1024 * 1024
})()
const blobCache = new Map<string, BlobResult>()
let blobCacheBytes = 0

function blobWeight (blob: BlobResult): number {
  // Account for a small fixed overhead so binary entries (empty text) still occupy a slot.
  return blob.text.length + 256
}

function evictBlobCache (): void {
  while (blobCacheBytes > BLOB_CACHE_MAX_BYTES && blobCache.size > 0) {
    const oldest = blobCache.keys().next().value
    if (oldest === undefined) break
    const victim = blobCache.get(oldest)
    blobCache.delete(oldest)
    if (victim) blobCacheBytes -= blobWeight(victim)
    logger.debug({ hash: oldest, blobCacheBytes, blobCacheSize: blobCache.size }, 'blob cache evict')
  }
}

async function getOrFetchBlob (hash: string): Promise<BlobResult> {
  const cached = blobCache.get(hash)
  if (cached) {
    // LRU bump: re-insert so this entry moves to the end of iteration order.
    blobCache.delete(hash)
    blobCache.set(hash, cached)
    logger.debug({ hash, bytes: cached.bytes, blobCacheBytes, blobCacheSize: blobCache.size }, 'blob cache hit')
    return cached
  }
  const start = Date.now()
  const blob = await fetchBlob(hash, {
    baseUrl: SOCKET_BLOB_URL,
    userAgent: BROWSER_USER_AGENT,
    extraHeaders: BYPASS_HEADERS,
    onRequest: (url) => logger.debug({ url }, 'blob request')
  })
  logger.debug(
    { hash, bytes: blob.bytes, binary: blob.binary, truncated: blob.truncated, contentType: blob.contentType, durationMs: Date.now() - start },
    'blob fetched'
  )
  blobCache.set(hash, blob)
  blobCacheBytes += blobWeight(blob)
  evictBlobCache()
  return blob
}

/** Creates a configured McpServer with tools. Used for stdio (single instance) and HTTP (fresh per request in stateless mode). */
function createConfiguredServer (): McpServer {
  const srv = new McpServer({ name: 'socket', version: VERSION })
  srv.registerTool(
    'depscore',
    {
      title: 'Dependency Score Tool',
      description: "Get the dependency score of packages with the `depscore` tool from Socket. Use 'unknown' for version if not known. Use this tool to scan dependencies for their quality and security on existing code or when code is generated. Stop generating code and ask the user how to proceed when any of the scores are low. When checking dependencies, make sure to also check the imports in the code, not just the manifest files (pyproject.toml, package.json, etc).",
      inputSchema: {
        packages: z.array(z.object({
          ecosystem: z.string().describe('The package ecosystem (e.g., npm, pypi, gem, golang, maven, nuget, cargo, chrome, openvsx)').default('npm'),
          depname: z.string().describe('The name of the dependency'),
          version: z.string().describe("The version of the dependency, use 'unknown' if not known").default('unknown'),
        })).describe('Array of packages to check'),
        platform: z.string().optional().describe("Optional OS-architecture hint (e.g., 'linux-x64', 'darwin-arm64', 'win32-x64'). Used to select the most relevant artifact when a package has platform-specific builds."),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ packages, platform }, extra) => {
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

      // Build components array for the API request. Use packageurl-js for correct PURL encoding
      // across ecosystems (e.g. @ in npm scoped packages, maven groupId:artifactId).
      const components = packages.map((pkg: { ecosystem?: string; depname: string; version?: string }) => {
        const cleanedVersion = (pkg.version ?? 'unknown').replace(/[\^~]/g, '') // Remove ^ and ~ from version
        const ecosystem = pkg.ecosystem ?? 'npm'
        const purl = buildPurl(ecosystem, pkg.depname, cleanedVersion)
        if (cleanedVersion !== '1.0.0' && cleanedVersion !== 'unknown' && cleanedVersion) {
          logger.info(`Using version ${cleanedVersion} for ${pkg.depname}`)
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
              .filter((obj: Record<string, unknown>) => !obj['_type'])

            if (!jsonLines.length) {
              const errorMsg = 'No valid JSON objects found in NDJSON response'
              return {
                content: [{ type: 'text', text: errorMsg }],
                isError: true
              }
            }

            const deduplicated = deduplicateArtifacts(jsonLines, platform)
            for (const jsonData of deduplicated) {
              const ns = jsonData.namespace ? `${jsonData.namespace}/` : ''
              const purl: string = `pkg:${jsonData.type || 'unknown'}/${ns}${jsonData.name || 'unknown'}@${jsonData.version || 'unknown'}`
              if (jsonData.score && jsonData.score['overall'] !== undefined) {
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
            const ns = jsonData.namespace ? `${jsonData.namespace}/` : ''
            const purl: string = `pkg:${jsonData.type || 'unknown'}/${ns}${jsonData.name || 'unknown'}@${jsonData.version || 'unknown'}`
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

  function buildPurlForFiles (
    ecosystem: string,
    depname: string,
    version: string,
    artifactId?: string,
    platform?: string
  ): string {
    const qualifiers: Record<string, string> = {}
    if (artifactId) qualifiers['artifact_id'] = artifactId
    if (platform) qualifiers['platform'] = platform
    return buildPurl(ecosystem, depname, version, Object.keys(qualifiers).length ? qualifiers : undefined)
  }

  srv.registerTool(
    'package_files',
    {
      title: 'Package File List Tool',
      description: "List the files published in a package using the `package_files` tool from Socket. Returns a tree of paths and sizes for any package on a supported ecosystem (npm, pypi, gem, cargo, maven, golang, nuget, chrome, openvsx). Useful for inspecting what a dependency ships before installing it. After calling this, use `package_file_contents` with one of the paths to read the file's contents.",
      inputSchema: {
        ecosystem: z.string().describe('Package ecosystem (e.g., npm, pypi, gem, cargo, maven, golang, nuget, chrome, openvsx)').default('npm'),
        depname: z.string().describe('Package name (e.g., "lodash", "@babel/core", "org.springframework:spring-core", "meta/pyrefly" for openvsx)'),
        version: z.string().describe('Package version'),
        artifactId: z.string().optional().describe('Per-version artifact disambiguator (e.g. PyPI filename, Maven artifact id, NuGet asset). Required when an ecosystem ships multiple artifacts per version.'),
        platform: z.string().optional().describe("Platform qualifier for ecosystems with per-OS/arch artifacts (e.g. openvsx: 'linux-x64', 'darwin-arm64', 'win32-x64').")
      },
      annotations: {
        readOnlyHint: true
      }
    },
    async ({ ecosystem, depname, version, artifactId, platform }, extra) => {
      const purlWithQualifiers = buildPurlForFiles(ecosystem ?? 'npm', depname, version, artifactId, platform)
      logger.info({ tool: 'package_files', ecosystem, depname, version, artifactId, platform, purl: purlWithQualifiers }, 'tool invoked')

      const accessToken = extra.authInfo?.token || SOCKET_API_KEY
      if (!accessToken) {
        const errorMsg = 'Authentication is required. Configure SOCKET_API_KEY for stdio mode or connect through OAuth-enabled HTTP mode.'
        logger.error(errorMsg)
        return {
          content: [{ type: 'text', text: errorMsg }],
          isError: true
        }
      }

      try {
        const start = Date.now()
        const result = await fetchFileList(purlWithQualifiers, {
          baseUrl: SOCKET_API_BASE_URL,
          includeHashes: true,
          userAgent: INTERNAL_USER_AGENT,
          authToken: accessToken,
          onRequest: (url) => logger.debug({ url }, 'file list request')
        })
        logger.debug(
          { purl: purlWithQualifiers, files: result.fileCount, totalBytes: result.totalBytes, durationMs: Date.now() - start },
          'file list fetched'
        )

        if (result.fileCount === 0) {
          return {
            content: [{ type: 'text', text: `No files found for ${result.purl}` }]
          }
        }

        const sizeKb = (result.totalBytes / 1024).toFixed(1)
        const header = `${result.purl} — ${result.fileCount} files, ${sizeKb} KB`
        return {
          content: [{ type: 'text', text: `${header}\n${result.tree}` }]
        }
      } catch (e) {
        const error = e as Error
        const errorMsg = `Error fetching file list for ${purlWithQualifiers}: ${error.message}`
        logger.error(errorMsg)
        return {
          content: [{ type: 'text', text: errorMsg }],
          isError: true
        }
      }
    }
  )

  srv.registerTool(
    'organizations',
    {
      title: 'List Organizations Tool',
      description: "List the Socket organizations the authenticated user belongs to with the `organizations` tool. Use this to discover the `org_slug` values needed by other org-scoped tools (e.g. `alerts`), or when the user asks which organizations they have access to.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true
      }
    },
    async (_args, extra) => {
      logger.info({ tool: 'organizations' }, 'tool invoked')

      const accessToken = extra.authInfo?.token || SOCKET_API_KEY
      if (!accessToken) {
        const errorMsg = 'Authentication is required. Configure SOCKET_API_KEY for stdio mode or connect through OAuth-enabled HTTP mode.'
        logger.error(errorMsg)
        return {
          content: [{ type: 'text', text: errorMsg }],
          isError: true
        }
      }

      try {
        const data = await fetchOrganizations({
          baseUrl: SOCKET_API_BASE_URL,
          userAgent: `socket-mcp/${VERSION}`,
          authToken: accessToken
        })
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
        }
      } catch (e) {
        const error = e as Error
        const errorMsg = `Error fetching organizations: ${error.message}`
        logger.error(errorMsg)
        return {
          content: [{ type: 'text', text: errorMsg }],
          isError: true
        }
      }
    }
  )

  srv.registerTool(
    'alerts',
    {
      title: 'List Alerts Tool',
      description: "List the latest security alerts for a Socket organization with the `alerts` tool. Requires `org_slug` — call the `organizations` tool first if you don't have it. Supports filtering by severity, category, status, artifact type/name, alert type, and repo. Use this to surface supply-chain, vulnerability, quality, license, and maintenance issues across the org's monitored packages. Results are paginated — pass the previous response's `endCursor` as `cursor` to fetch the next page.",
      inputSchema: {
        org_slug: z.string().describe('Organization slug, e.g. "my-org" (use the `organizations` tool to discover this)'),
        severity: z.string().optional().describe('Comma-separated severities to include: subset of low,medium,high,critical'),
        status: z.enum(['open', 'cleared']).optional().describe('Filter to open or cleared alerts'),
        category: z.string().optional().describe('Comma-separated categories: subset of supplyChainRisk,maintenance,quality,license,vulnerability'),
        artifact_type: z.string().optional().describe('Comma-separated ecosystems: subset of npm,pypi,gem,maven,golang,nuget,cargo,chrome,openvsx'),
        artifact_name: z.string().optional().describe('Filter to a specific package name'),
        alert_type: z.string().optional().describe('Comma-separated Socket alert types (e.g. "usesEval,unmaintained")'),
        repo_slug: z.string().optional().describe('Comma-separated repo slugs'),
        per_page: z.number().int().min(1).max(5000).optional().describe('Results per page (default 100, max 5000)'),
        cursor: z.string().optional().describe("Pagination cursor — the `endCursor` from a previous response's metadata")
      },
      annotations: {
        readOnlyHint: true
      }
    },
    async (args, extra) => {
      logger.info({ tool: 'alerts', org_slug: args.org_slug, filters: { severity: args.severity, status: args.status, category: args.category, artifact_type: args.artifact_type, alert_type: args.alert_type } }, 'tool invoked')

      const accessToken = extra.authInfo?.token || SOCKET_API_KEY
      if (!accessToken) {
        const errorMsg = 'Authentication is required. Configure SOCKET_API_KEY for stdio mode or connect through OAuth-enabled HTTP mode.'
        logger.error(errorMsg)
        return {
          content: [{ type: 'text', text: errorMsg }],
          isError: true
        }
      }

      try {
        const data = await fetchAlerts({
          baseUrl: SOCKET_API_BASE_URL,
          orgSlug: args.org_slug,
          userAgent: `socket-mcp/${VERSION}`,
          authToken: accessToken,
          filters: {
            ...(args.severity ? { severity: args.severity } : {}),
            ...(args.status ? { status: args.status } : {}),
            ...(args.category ? { category: args.category } : {}),
            ...(args.artifact_type ? { artifactType: args.artifact_type } : {}),
            ...(args.artifact_name ? { artifactName: args.artifact_name } : {}),
            ...(args.alert_type ? { alertType: args.alert_type } : {}),
            ...(args.repo_slug ? { repoSlug: args.repo_slug } : {}),
            // Default to 100 (vs API's 1000) to keep tool responses LLM-friendly.
            perPage: args.per_page ?? 100,
            ...(args.cursor ? { cursor: args.cursor } : {})
          }
        })
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
        }
      } catch (e) {
        const error = e as Error
        const errorMsg = `Error fetching alerts for ${args.org_slug}: ${error.message}`
        logger.error(errorMsg)
        return {
          content: [{ type: 'text', text: errorMsg }],
          isError: true
        }
      }
    }
  )

  srv.registerTool(
    'threat_feed',
    {
      title: 'Threat Feed Tool',
      description: "Look up items in the Socket organization threat feed with the `threat_feed` tool. Requires `org_slug` — call the `organizations` tool first if you don't have it. Returns recently flagged packages (malware, typosquats, obfuscated code, etc.) along with a `nextPageCursor` for pagination. Use `filter` to narrow the threat category (default `mal` for malware), `ecosystem` to scope to a registry, or `name`/`version` to look up a specific package. Pass the previous response's cursor as `cursor` to fetch the next page.",
      inputSchema: {
        org_slug: z.string().describe('Organization slug, e.g. "my-org" (use the `organizations` tool to discover this)'),
        filter: z.string().optional().describe('Threat category filter (default `mal`). Common values: `mal` (malware), `vuln`, `typ` (typosquat), `obf` (obfuscated), `mjo`, `kes`, `spy`, `ano`, `ucf`, `ptp`, `ual`'),
        ecosystem: z.string().optional().describe('Ecosystem filter, e.g. npm, pypi, gem, maven, golang, nuget, cargo, chrome, openvsx, vscode, huggingface'),
        name: z.string().optional().describe('Filter by package name'),
        version: z.string().optional().describe('Filter by package version'),
        is_human_reviewed: z.boolean().optional().describe('Only return human-reviewed items (default false)'),
        sort: z.enum(['id', 'created_at', 'updated_at']).optional().describe('Sort field (default `updated_at`)'),
        direction: z.enum(['asc', 'desc']).optional().describe('Sort direction (default `desc`)'),
        updated_after: z.string().optional().describe('ISO timestamp; only return items updated after this'),
        created_after: z.string().optional().describe('ISO timestamp; only return items created after this'),
        per_page: z.number().int().min(1).max(100).optional().describe('Results per page (default 30, max 100)'),
        cursor: z.string().optional().describe("Pagination cursor — the `nextPageCursor` from a previous response")
      },
      annotations: {
        readOnlyHint: true
      }
    },
    async (args, extra) => {
      logger.info({ tool: 'threat_feed', org_slug: args.org_slug, filters: { filter: args.filter, ecosystem: args.ecosystem, name: args.name, version: args.version } }, 'tool invoked')

      const accessToken = extra.authInfo?.token || SOCKET_API_KEY
      if (!accessToken) {
        const errorMsg = 'Authentication is required. Configure SOCKET_API_KEY for stdio mode or connect through OAuth-enabled HTTP mode.'
        logger.error(errorMsg)
        return {
          content: [{ type: 'text', text: errorMsg }],
          isError: true
        }
      }

      try {
        const data = await fetchThreatFeed({
          baseUrl: SOCKET_API_BASE_URL,
          orgSlug: args.org_slug,
          userAgent: `socket-mcp/${VERSION}`,
          authToken: accessToken,
          filters: {
            ...(args.filter ? { filter: args.filter } : {}),
            ...(args.ecosystem ? { ecosystem: args.ecosystem } : {}),
            ...(args.name ? { name: args.name } : {}),
            ...(args.version ? { version: args.version } : {}),
            ...(typeof args.is_human_reviewed === 'boolean' ? { isHumanReviewed: args.is_human_reviewed } : {}),
            ...(args.sort ? { sort: args.sort } : {}),
            ...(args.direction ? { direction: args.direction } : {}),
            ...(args.updated_after ? { updatedAfter: args.updated_after } : {}),
            ...(args.created_after ? { createdAfter: args.created_after } : {}),
            ...(typeof args.per_page === 'number' ? { perPage: args.per_page } : {}),
            ...(args.cursor ? { cursor: args.cursor } : {})
          }
        })
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
        }
      } catch (e) {
        const error = e as Error
        const errorMsg = `Error fetching threat feed for ${args.org_slug}: ${error.message}`
        logger.error(errorMsg)
        return {
          content: [{ type: 'text', text: errorMsg }],
          isError: true
        }
      }
    }
  )

  srv.registerTool(
    'package_file_contents',
    {
      title: 'Package File Contents Tool',
      description: "Read a single file from a package using the `package_file_contents` tool from Socket. Pass the `hash` printed next to each entry in `package_files` output. Returns up to 1 MB of UTF-8 text; binary files return metadata only.",
      inputSchema: {
        hash: z.string().describe('Blob hash exactly as shown by `package_files` (the token printed after each file size)'),
        path: z.string().optional().describe('Optional file path for display only; does not affect the lookup')
      },
      annotations: {
        readOnlyHint: true
      }
    },
    async ({ hash, path }) => {
      const label = path ?? hash
      logger.info({ tool: 'package_file_contents', hash, path }, 'tool invoked')

      try {
        const blob = await getOrFetchBlob(hash)

        if (blob.binary) {
          return {
            content: [{
              type: 'text',
              text: `${label} appears to be binary (${blob.bytes} bytes, content-type: ${blob.contentType ?? 'unknown'}). Refusing to return binary contents.`
            }]
          }
        }

        const truncationNote = blob.truncated
          ? `\n\n[truncated — file is ${blob.bytes} bytes, returning first 1 MB]`
          : ''
        const header = `${label} (${blob.bytes} bytes)`
        return {
          content: [{ type: 'text', text: `${header}\n\n${blob.text}${truncationNote}` }]
        }
      } catch (e) {
        const error = e as Error
        const errorMsg = `Error fetching blob ${hash}: ${error.message}`
        logger.error(errorMsg)
        return {
          content: [{ type: 'text', text: errorMsg }],
          isError: true
        }
      }
    }
  )

  srv.registerTool(
    'package_file_grep',
    {
      title: 'Package File Grep Tool',
      description: "Search a single file from a package for lines matching a JavaScript regular expression. Pass the `hash` printed next to each entry in `package_files` output. The file is fetched from Socket once per session and cached, so repeated greps on the same hash skip the network. Returns matching lines with line numbers (grep -n style); binary files are refused. Useful for locating a specific symbol, import, or string inside a dependency without dumping the whole file.",
      inputSchema: {
        hash: z.string().describe('Blob hash exactly as shown by `package_files` (the token printed after each file size)'),
        pattern: z.string().describe('JavaScript regular expression. Plain literal strings work too. Anchors and character classes are supported.'),
        caseInsensitive: z.boolean().optional().describe('Match case-insensitively (default: false)'),
        contextLines: z.number().int().min(0).max(5).optional().describe('Lines of context to show before and after each match (0-5, default: 0)'),
        maxMatches: z.number().int().min(1).max(500).optional().describe('Cap on number of matching lines returned (default: 100, max: 500)'),
        path: z.string().optional().describe('Optional file path for display only; does not affect the lookup')
      },
      annotations: {
        readOnlyHint: true
      }
    },
    async ({ hash, pattern, caseInsensitive, contextLines, maxMatches, path }) => {
      const label = path ?? hash
      const cap = maxMatches ?? 100
      const ctx = contextLines ?? 0
      logger.info({ tool: 'package_file_grep', hash, path, pattern, caseInsensitive, contextLines: ctx, maxMatches: cap }, 'tool invoked')

      let re: RegExp
      try {
        re = new RegExp(pattern, caseInsensitive ? 'i' : '')
      } catch (e) {
        const errorMsg = `Invalid regular expression: ${(e as Error).message}`
        return {
          content: [{ type: 'text', text: errorMsg }],
          isError: true
        }
      }

      try {
        const blob = await getOrFetchBlob(hash)

        if (blob.binary) {
          return {
            content: [{
              type: 'text',
              text: `${label} appears to be binary (${blob.bytes} bytes, content-type: ${blob.contentType ?? 'unknown'}). Refusing to grep binary contents.`
            }],
            isError: true
          }
        }

        const lines = blob.text.split('\n')
        const matchIndexes: number[] = []
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i]!)) {
            matchIndexes.push(i)
            if (matchIndexes.length >= cap) break
          }
        }

        if (matchIndexes.length === 0) {
          return {
            content: [{ type: 'text', text: `${label}: no matches for /${pattern}/${caseInsensitive ? 'i' : ''}` }]
          }
        }

        const lineWidth = String(lines.length).length
        const formatLine = (idx: number, sep: ':' | '-'): string =>
          `${String(idx + 1).padStart(lineWidth, ' ')}${sep} ${lines[idx]}`

        const out: string[] = []
        let lastPrinted = -1
        for (let m = 0; m < matchIndexes.length; m++) {
          const matchIdx = matchIndexes[m]!
          const start = Math.max(0, matchIdx - ctx)
          const end = Math.min(lines.length - 1, matchIdx + ctx)
          if (ctx > 0 && lastPrinted >= 0 && start > lastPrinted + 1) {
            out.push('--')
          }
          for (let i = Math.max(start, lastPrinted + 1); i <= end; i++) {
            out.push(formatLine(i, i === matchIdx ? ':' : '-'))
          }
          lastPrinted = end
        }

        const truncationNote = blob.truncated
          ? `\n[note: file is ${blob.bytes} bytes; searched only the first 1 MB]`
          : ''
        const capNote = matchIndexes.length >= cap
          ? `\n[note: stopped at maxMatches=${cap}; more matches may exist]`
          : ''
        const header = `${label} — ${matchIndexes.length} match${matchIndexes.length === 1 ? '' : 'es'} for /${pattern}/${caseInsensitive ? 'i' : ''}`
        return {
          content: [{ type: 'text', text: `${header}\n${out.join('\n')}${truncationNote}${capNote}` }]
        }
      } catch (e) {
        const error = e as Error
        const errorMsg = `Error grepping blob ${hash}: ${error.message}`
        logger.error(errorMsg)
        return {
          content: [{ type: 'text', text: errorMsg }],
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

  // Stateless mode: each POST gets a fresh McpServer + Transport. No session
  // tracking, no GET/DELETE — the client treats every request as independent.
  // Trade-off: server-push notifications are unavailable, but clients survive
  // restarts cleanly because there's no stale session state to reuse.

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
      } else {
        // Passthrough mode: when OAuth isn't configured, accept any Bearer token
        // and forward it to Socket's API as the caller's API key. Not verified
        // locally — Socket's API rejects invalid keys on outbound calls. If no
        // Bearer is sent, tool handlers fall back to the server's SOCKET_API_KEY.
        const authHeader = getRequestHeaderValue(req.headers.authorization).trim()
        if (authHeader) {
          const [type, token] = authHeader.split(/\s+/u)
          if ((type || '').toLowerCase() === 'bearer' && token) {
            authenticatedReq.auth = { token, clientId: 'bearer-passthrough', scopes: [] }
          }
        }
      }

      if (req.method === 'POST') {
        let body = ''
        req.on('data', (chunk: string) => { body += chunk })
        req.on('end', async () => {
          let jsonData: unknown
          try {
            jsonData = JSON.parse(body)
          } catch (error) {
            logger.warn(`Invalid JSON in POST body: ${error}`)
            writeJson(res, 400, {
              jsonrpc: '2.0',
              error: { code: -32700, message: 'Parse error' },
              id: null
            })
            return
          }

          if (isInitializeRequest(jsonData)) {
            const clientInfo = (jsonData as { params?: { clientInfo?: { name?: string; version?: string } } }).params?.clientInfo
            logger.info(`Client connected: ${clientInfo?.name || 'unknown'} v${clientInfo?.version || 'unknown'} from ${origin || host}`)
          }

          const server = createConfiguredServer()
          // Stateless mode: omit sessionIdGenerator entirely. The SDK treats a
          // missing generator as "no session tracking" and returns immediate
          // JSON responses with enableJsonResponse.
          const transport = new StreamableHTTPServerTransport({
            enableJsonResponse: true
          })

          // Tear down per-request server+transport when the response closes.
          res.on('close', () => {
            try { transport.close() } catch {}
            server.close().catch(() => {})
          })

          try {
            await server.connect(transport as Transport)
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
      } else if (req.method === 'GET' || req.method === 'DELETE') {
        // Stateless mode: no sessions to stream from or terminate.
        writeJson(res, 405, {
          jsonrpc: '2.0',
          error: { code: -32000, message: `${req.method} not supported in stateless mode. Use POST.` },
          id: null
        })
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
