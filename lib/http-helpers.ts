import readline from 'node:readline'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { errorMessage } from '@socketsecurity/lib/errors'
import { httpRequest } from '@socketsecurity/lib/http-request/request'
import type { HttpRequestOptions } from '@socketsecurity/lib/http-request/request-types'
import type { HttpResponse } from '@socketsecurity/lib/http-request/response-types'

import { getTrustProxy } from './env.ts'
import { logger } from './logger.ts'
import { VERSION } from './version.ts'

// Trust forwarded headers only when an operator has explicitly opted in by
// setting TRUST_PROXY=true. Without this gate, any client could spoof
// X-Forwarded-Host / X-Forwarded-Proto and influence OAuth metadata URLs.
// Resolved via the fleet-canonical helper so the env-var name + parse
// semantics stay in lockstep across the fleet.
export const TRUST_PROXY: boolean = getTrustProxy()

// Loopback / link-local / private IPv4 ranges + IPv6 loopback/ULA that an
// SSRF probe would target. Compared against the resolved URL host.
const PRIVATE_HOST_RE =
  /^(?:0\.0\.0\.0$|10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|\[?::1\]?$|\[?fc00:|\[?fd|\[?fe80:)/iu

/**
 * SSRF guard for operator/issuer-supplied URLs (the OAuth issuer + the
 * introspection endpoint advertised in its metadata). Rejects non-HTTP(S)
 * schemes and hosts that resolve to loopback/private/link-local ranges, so a
 * malicious or MITM'd OAuth server can't pivot the server into internal
 * services (cloud metadata, redis, etc). `allowLocalhost` opens the gate for
 * `localhost`/127.0.0.1 in local-stack development only.
 */
export function assertSafeHttpUrl(
  rawUrl: string,
  label: string,
  allowLocalhost = false,
): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error(`${label} is not a valid URL: ${rawUrl}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} must be http(s): ${rawUrl}`)
  }
  const host = url.hostname.toLowerCase()
  const isLocal = host === '127.0.0.1' || host === '::1' || host === 'localhost'
  if (isLocal && allowLocalhost) {
    return url
  }
  if (PRIVATE_HOST_RE.test(host) || isLocal) {
    throw new Error(
      `${label} resolves to a private/loopback host and is refused: ${rawUrl}`,
    )
  }
  return url
}

// Build request headers for the JSON REST endpoints (alerts, organizations,
// threat-feed, file-list): `accept: application/json` plus optional user-agent,
// bearer token, and caller extra headers. Shared so the four data modules
// don't each re-spell the same header-assembly block.
export function buildJsonApiHeaders(options: {
  userAgent?: string | undefined
  authToken?: string | undefined
  extraHeaders?: Record<string, string> | undefined
}): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (options.userAgent) {
    headers['user-agent'] = options.userAgent
  }
  if (options.authToken) {
    headers['authorization'] = `Bearer ${options.authToken}`
  }
  if (options.extraHeaders) {
    Object.assign(headers, options.extraHeaders)
  }
  return headers
}

// Build the Socket API request headers carrying the optional bearer token.
// The Accept header pins NDJSON so the depscore handler can stream rows
// instead of buffering a full JSON document.
export function buildSocketHeaders(
  accessToken?: string,
): Record<string, string> {
  return {
    'user-agent': `socket-mcp/${VERSION}`,
    accept: 'application/x-ndjson',
    'content-type': 'application/json',
    ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
  }
}

// `@socketsecurity/lib@6.0.6`'s `httpRequest` advertises `Accept-Encoding:
// gzip, br` but never decompresses the response on its main path — only the
// unused `readIncomingResponse` bypass decodes. A `Content-Encoding: br` reply
// (e.g. the Socket file-list endpoint) then reaches `.json()`/`.text()` as raw
// compressed bytes and fails to parse with `Unexpected token '�'`. Until
// the lib decodes on its main path, force `Accept-Encoding: identity` so the
// server returns uncompressed bodies. The override is appended last so it wins
// the lib's header merge (and any caller header) regardless of order. Route
// every Socket-bound request through this wrapper so no call site can fall
// back onto the broken decode path.
export function socketHttpRequest(
  url: string,
  options: HttpRequestOptions = {},
): Promise<HttpResponse> {
  return httpRequest(url, {
    ...options,
    headers: { ...options.headers, 'Accept-Encoding': 'identity' },
  })
}

// Prompt for a Socket API token interactively. Only viable in HTTP mode —
// stdio mode's stdin is the MCP protocol channel.
export async function getApiKeyInteractively(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  })

  const apiKey = await new Promise<string>(resolve => {
    rl.question(
      'Please enter your Socket API key: ',
      (answer: string | PromiseLike<string>) => {
        rl.close()
        resolve(answer)
      },
    )
  })

  if (!apiKey) {
    logger.error('No API key provided')
    process.exit(1)
  }

  return apiKey
}

// Comma-separated forwarded headers (e.g. X-Forwarded-For) list multiple
// hops; the originating client is the first entry.
export function getForwardedHeaderValue(
  header: string | string[] | undefined,
): string {
  return getRequestHeaderValue(header).split(',', 1)[0]?.trim() || ''
}

// Compose the public base URL of the incoming request. When TRUST_PROXY
// is enabled, X-Forwarded-Host / X-Forwarded-Proto override the request's
// observed host and protocol; otherwise they are ignored to prevent
// spoofing.
export function getRequestBaseUrl(
  req: IncomingMessage,
  fallbackPort: number,
  trustProxy: boolean = TRUST_PROXY,
): URL {
  const forwardedProto = trustProxy
    ? getForwardedHeaderValue(req.headers['x-forwarded-proto']).toLowerCase()
    : ''
  const forwardedHostRaw = trustProxy
    ? getForwardedHeaderValue(req.headers['x-forwarded-host'])
    : ''
  // Even under TRUST_PROXY, only accept a bare host[:port] from
  // X-Forwarded-Host — reject anything carrying a scheme, userinfo, path, or
  // multiple comma-joined hosts, so a poisoned header can't smuggle a
  // different origin into the OAuth metadata URLs.
  const forwardedHost = /^[a-z0-9.-]+(?::\d+)?$/iu.test(forwardedHostRaw)
    ? forwardedHostRaw
    : ''
  const host =
    forwardedHost ||
    getRequestHeaderValue(req.headers.host).trim() ||
    `localhost:${fallbackPort}`
  const socketWithTls = req.socket as { encrypted?: boolean | undefined }
  const protocol =
    forwardedProto === 'http' || forwardedProto === 'https'
      ? forwardedProto
      : socketWithTls.encrypted
        ? 'https'
        : 'http'

  return new URL(`${protocol}://${host}/`)
}

// Pull a single value out of a header that Node represents as
// string | string[] | undefined. Node yields an array for duplicated
// headers; we take the first.
export function getRequestHeaderValue(
  header: string | string[] | undefined,
): string {
  if (Array.isArray(header)) {
    return header[0] || ''
  }

  return header || ''
}

// Parse a response body that must be a JSON object — not an array, not a
// primitive. Throws a contextual error pointing at the upstream caller.
export function parseJsonObject(
  responseText: string,
  context: string,
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(responseText)

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected a JSON object')
    }

    return parsed as Record<string, unknown>
  } catch (error) {
    throw new Error(`${context} returned invalid JSON: ${errorMessage(error)}`)
  }
}

// Helper for emitting JSON HTTP responses with a consistent Content-Type
// and optional extra headers (used by writeOAuthError to attach
// WWW-Authenticate).
export function writeJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    ...headers,
  })
  res.end(JSON.stringify(body))
}

// RFC 6750 §3 OAuth error responses: the JSON body carries
// error / error_description and the WWW-Authenticate header signals the
// realm + optional resource_metadata URL for discovery.
export function writeOAuthError(
  res: ServerResponse,
  statusCode: number,
  errorCode: string,
  message: string,
  resourceMetadataUrl?: string,
): void {
  const authenticateValue = resourceMetadataUrl
    ? `Bearer error="${errorCode}", error_description="${message}", resource_metadata="${resourceMetadataUrl}"`
    : `Bearer error="${errorCode}", error_description="${message}"`

  writeJson(
    res,
    statusCode,
    {
      error: errorCode,
      error_description: message,
    },
    { 'WWW-Authenticate': authenticateValue },
  )
}
