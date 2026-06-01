import readline from 'node:readline'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { errorMessage } from '@socketsecurity/lib/errors'

import { getTrustProxy } from './env.ts'
import { logger } from './logger.ts'
import { VERSION } from './version.ts'

// Trust forwarded headers only when an operator has explicitly opted in by
// setting TRUST_PROXY=true. Without this gate, any client could spoof
// X-Forwarded-Host / X-Forwarded-Proto and influence OAuth metadata URLs.
// Resolved via the fleet-canonical helper so the env-var name + parse
// semantics stay in lockstep across the fleet.
export const TRUST_PROXY: boolean = getTrustProxy()

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
  const forwardedHost = trustProxy
    ? getForwardedHeaderValue(req.headers['x-forwarded-host'])
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
