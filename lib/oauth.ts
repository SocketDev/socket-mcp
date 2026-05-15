import {
  getSocketOauthIntrospectionClientId,
  getSocketOauthIntrospectionClientSecret,
  getSocketOauthIssuer,
  getSocketOauthRequiredScopes,
} from '@socketsecurity/lib-stable/env/socket'
import { httpRequest } from '@socketsecurity/lib-stable/http-request'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  getRequestHeaderValue,
  parseJsonObject,
  writeJson,
  writeOAuthError,
} from './http-helpers.ts'
import { logger } from './logger.ts'

export interface OAuthAuthorizationServerMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  introspection_endpoint: string
  [key: string]: unknown
}

export type AuthenticatedRequest = IncomingMessage & {
  auth?: AuthInfo | undefined
}

export const OAUTH_PROTECTED_RESOURCE_METADATA_PATH =
  '/.well-known/oauth-protected-resource'
const OAUTH_WELL_KNOWN_PATH = '/.well-known/oauth-authorization-server'

// All four OAuth env vars resolved via the fleet-canonical helpers in
// @socketsecurity/lib/env/socket. Centralizing the reads means an env-
// var rename / alias-table change is a single-file edit upstream;
// socket-mcp picks it up on the next dep bump.
const SOCKET_OAUTH_ISSUER = getSocketOauthIssuer()
const SOCKET_OAUTH_INTROSPECTION_CLIENT_ID =
  getSocketOauthIntrospectionClientId()
const SOCKET_OAUTH_INTROSPECTION_CLIENT_SECRET =
  getSocketOauthIntrospectionClientSecret()
export const SOCKET_OAUTH_REQUIRED_SCOPES: string[] =
  getSocketOauthRequiredScopes()
    .split(/\s+/u)
    .map(scope => scope.trim())
    .filter(Boolean)

// True when ANY of the three introspection settings are configured —
// caller uses this to detect partial / incomplete configs and refuse to
// start.
export const hasAnyOAuthConfig: boolean = Boolean(
  SOCKET_OAUTH_ISSUER ||
  SOCKET_OAUTH_INTROSPECTION_CLIENT_ID ||
  SOCKET_OAUTH_INTROSPECTION_CLIENT_SECRET,
)

const allOAuthConfig = Boolean(
  SOCKET_OAUTH_ISSUER &&
  SOCKET_OAUTH_INTROSPECTION_CLIENT_ID &&
  SOCKET_OAUTH_INTROSPECTION_CLIENT_SECRET,
)

// Cached discovery promise — populated on first call and cleared on
// failure so a transient discovery error doesn't permanently break the
// server.
let oauthMetadataPromise: Promise<OAuthAuthorizationServerMetadata> | undefined

// Tracks whether OAuth has been opted into for the running mode (only
// HTTP). Set once during boot to gate metadata loading on configuration.
let oauthEnabledFlag = false

const REQUIRED_OAUTH_FIELDS = [
  'issuer',
  'authorization_endpoint',
  'token_endpoint',
  'introspection_endpoint',
] as const

// Run the bearer-token validation pipeline for incoming MCP requests:
// presence check → format check → introspection → expiry → scope check.
// Each failure step emits the matching RFC 6750 / RFC 7662 error.
export async function authenticateRequest(
  req: AuthenticatedRequest,
  res: ServerResponse,
  resourceMetadataUrl: string,
): Promise<{ ok: false } | { ok: true; authInfo: AuthInfo }> {
  const authHeader = getRequestHeaderValue(req.headers.authorization).trim()
  if (!authHeader) {
    writeOAuthError(
      res,
      401,
      'invalid_request',
      'Missing Authorization header',
      resourceMetadataUrl,
    )
    return { ok: false }
  }

  const [type, token] = authHeader.split(/\s+/u)
  if ((type || '').toLowerCase() !== 'bearer' || !token) {
    writeOAuthError(
      res,
      401,
      'invalid_request',
      "Invalid Authorization header format, expected 'Bearer TOKEN'",
      resourceMetadataUrl,
    )
    return { ok: false }
  }

  let authInfo: AuthInfo | undefined
  try {
    authInfo = await verifyAccessToken(token)
  } catch (error) {
    logger.error(
      `Token verification failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    writeJson(res, 500, {
      error: 'server_error',
      error_description: 'Token verification failed',
    })
    return { ok: false }
  }

  if (!authInfo) {
    writeOAuthError(
      res,
      401,
      'invalid_token',
      'Invalid or expired token',
      resourceMetadataUrl,
    )
    return { ok: false }
  }

  if (
    typeof authInfo.expiresAt === 'number' &&
    authInfo.expiresAt < Date.now() / 1000
  ) {
    writeOAuthError(
      res,
      401,
      'invalid_token',
      'Token has expired',
      resourceMetadataUrl,
    )
    return { ok: false }
  }

  const missingScopes = SOCKET_OAUTH_REQUIRED_SCOPES.filter(
    scope => !authInfo.scopes.includes(scope),
  )
  if (missingScopes.length > 0) {
    writeOAuthError(
      res,
      403,
      'insufficient_scope',
      `Missing required scopes: ${missingScopes.join(', ')}`,
      resourceMetadataUrl,
    )
    return { ok: false }
  }

  req.auth = authInfo
  return {
    ok: true,
    authInfo,
  }
}

// RFC 8707-style protected-resource metadata pointing clients at the
// upstream issuer with the scopes this resource requires.
export function buildProtectedResourceMetadata(
  baseUrl: URL,
  oauthMetadata: OAuthAuthorizationServerMetadata,
): Record<string, unknown> {
  return {
    resource: new URL('/', baseUrl).href,
    authorization_servers: [oauthMetadata.issuer],
    scopes_supported: SOCKET_OAUTH_REQUIRED_SCOPES,
    resource_name: 'Socket MCP Server',
  }
}

// URL clients should hit (advertised in WWW-Authenticate) to learn the
// resource metadata.
export function getProtectedResourceMetadataUrl(baseUrl: URL): string {
  return new URL(OAUTH_PROTECTED_RESOURCE_METADATA_PATH, baseUrl).href
}

export function isOauthEnabled(): boolean {
  return oauthEnabledFlag
}

// Discover the upstream issuer's authorization-server metadata
// (RFC 8414). The fetched metadata is cached; failures clear the cache so
// the next request retries.
export async function loadOAuthMetadata(): Promise<
  OAuthAuthorizationServerMetadata | undefined
> {
  if (!oauthEnabledFlag) {
    return undefined
  }

  if (!oauthMetadataPromise) {
    const metadataPromise = (async () => {
      const issuerUrl = new URL(SOCKET_OAUTH_ISSUER)
      const response = await httpRequest(
        new URL(OAUTH_WELL_KNOWN_PATH, issuerUrl).href,
      )
      const responseText = response.text()

      if (!response.ok) {
        throw new Error(
          `OAuth metadata discovery failed with status ${response.status}: ${responseText}`,
        )
      }

      const metadata = parseJsonObject(responseText, 'OAuth metadata discovery')

      validateOAuthMetadataFields(metadata)

      return metadata
    })()

    const retryableMetadataPromise = metadataPromise.catch(error => {
      if (oauthMetadataPromise === retryableMetadataPromise) {
        oauthMetadataPromise = undefined
      }

      throw error
    })

    oauthMetadataPromise = retryableMetadataPromise
  }

  return await oauthMetadataPromise
}

// Call this in HTTP mode after confirming all three settings are present.
// Returns the SOCKET_OAUTH_ISSUER (for logging) when enabled.
export function setOauthEnabled(): { issuer: string } | undefined {
  if (!allOAuthConfig) {
    return undefined
  }
  oauthEnabledFlag = true
  return { issuer: SOCKET_OAUTH_ISSUER }
}

// Tokenize the introspection "scope" field per RFC 6749 §3.3: a
// space-delimited list of bare scope strings.
export function splitScopes(scope: unknown): string[] {
  if (typeof scope !== 'string') {
    return []
  }

  return scope
    .split(/\s+/u)
    .map(value => value.trim())
    .filter(Boolean)
}

// Validate that an arbitrary 401-from-introspection response is well-formed
// for token verification — the introspection RFC requires `active` to be
// boolean.
export function validateOAuthMetadataFields(
  metadata: Record<string, unknown>,
): asserts metadata is OAuthAuthorizationServerMetadata {
  for (let i = 0, { length } = REQUIRED_OAUTH_FIELDS; i < length; i += 1) {
    const field = REQUIRED_OAUTH_FIELDS[i]!
    if (typeof metadata[field] !== 'string' || !metadata[field]) {
      throw new Error(`OAuth metadata missing required field: ${field}`)
    }
  }
}

// RFC 7662 token introspection — POST the bearer token to the upstream
// introspection endpoint using HTTP Basic auth for the introspection
// client. Returns AuthInfo on `active:true`, undefined on inactive.
export async function verifyAccessToken(
  token: string,
): Promise<AuthInfo | undefined> {
  const oauthMetadata = await loadOAuthMetadata()
  if (!oauthMetadata) {
    throw new Error('OAuth is not configured for this server')
  }

  const response = await httpRequest(oauthMetadata.introspection_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${SOCKET_OAUTH_INTROSPECTION_CLIENT_ID}:${SOCKET_OAUTH_INTROSPECTION_CLIENT_SECRET}`).toString('base64')}`,
    },
    body: new URLSearchParams({ token }).toString(),
  })
  const responseText = response.text()

  if (!response.ok) {
    throw new Error(
      `Token introspection failed with status ${response.status}: ${responseText}`,
    )
  }

  const introspection = parseJsonObject(responseText, 'Token introspection')
  if (!introspection['active']) {
    return undefined
  }

  const expiresAt =
    typeof introspection['exp'] === 'number'
      ? introspection['exp']
      : Number(introspection['exp'])

  return {
    token,
    clientId:
      typeof introspection['client_id'] === 'string'
        ? introspection['client_id']
        : 'unknown',
    scopes: splitScopes(introspection['scope']),
    ...(Number.isFinite(expiresAt) ? { expiresAt } : {}),
    extra: introspection,
  }
}
