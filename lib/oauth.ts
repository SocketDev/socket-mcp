import {
  getSocketOauthIntrospectionClientId,
  getSocketOauthIntrospectionClientSecret,
  getSocketOauthIssuer,
  getSocketOauthRequiredScopes,
} from './env.ts'
import { getSocketDebug } from '@socketsecurity/lib/env/socket'
import { errorMessage } from '@socketsecurity/lib/errors/message'
import { httpRequest } from '@socketsecurity/lib/http-request/request'
import { envAsBoolean } from '@socketsecurity/lib-stable/env/boolean'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  assertSafeHttpUrl,
  getRequestHeaderValue,
  parseJsonObject,
  writeJson,
  writeOAuthError,
} from './http-helpers.ts'
import { logger } from './logger.ts'

// In SOCKET_DEBUG local-stack mode the issuer/introspection endpoints may be
// on localhost; otherwise loopback/private hosts are refused as SSRF targets.
const ALLOW_LOCAL_OAUTH = envAsBoolean(getSocketDebug())

export interface OAuthAuthorizationServerMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  introspection_endpoint: string
  [key: string]: unknown
}

// MCP SDK's `handleRequest` expects `{ auth?: AuthInfo }` (no
// `| undefined`). Adding `| undefined` would satisfy our internal
// `optional-explicit-undefined` lint rule but break the structural
// match required by the SDK under `exactOptionalPropertyTypes: true`.
// Third-party shape wins.
// oxlint-disable-next-line socket/optional-explicit-undefined -- must match @modelcontextprotocol/sdk's AuthInfo container shape.
export type AuthenticatedRequest = IncomingMessage & { auth?: AuthInfo }

export const OAUTH_PROTECTED_RESOURCE_METADATA_PATH =
  '/.well-known/oauth-protected-resource'
const OAUTH_WELL_KNOWN_PATH = '/.well-known/oauth-authorization-server'

// Resolved OAuth settings + per-config discovery cache. The module
// default reads env (the production path); tests construct their own
// config so introspection/discovery can be driven against a nock-mocked
// issuer in-process, without env-driven module init or a spawned server.
export interface OAuthConfig {
  issuer: string
  introspectionClientId: string
  introspectionClientSecret: string
  requiredScopes: string[]
  // Cached discovery promise — populated on first call and cleared on
  // failure so a transient discovery error doesn't permanently break the
  // server. Lives on the config so each config has an isolated cache.
  metadataPromise: Promise<OAuthAuthorizationServerMetadata> | undefined
  // Tracks whether OAuth has been opted into for the running mode (only
  // HTTP). Set once during boot to gate metadata loading on configuration.
  enabled: boolean
}

// Module-default config (production path). HTTP-mode boot flips its
// `enabled` flag via setOauthEnabled(). `resolveOAuthConfig` is a
// function declaration so it hoists above this module-eval-time call
// despite living lower in the file (sorted into its export group).
const defaultConfig: OAuthConfig = resolveOAuthConfig()

// Back-compat export — the required scopes the resource advertises.
export const SOCKET_OAUTH_REQUIRED_SCOPES: string[] =
  defaultConfig.requiredScopes

// True when ANY of the three introspection settings are configured —
// caller uses this to detect partial / incomplete configs and refuse to
// start.
export const hasAnyOAuthConfig: boolean = Boolean(
  defaultConfig.introspectionClientId ||
  defaultConfig.introspectionClientSecret ||
  defaultConfig.issuer,
)

const allOAuthConfig = Boolean(
  defaultConfig.introspectionClientId &&
  defaultConfig.introspectionClientSecret &&
  defaultConfig.issuer,
)

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
  config: OAuthConfig = defaultConfig,
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
    authInfo = await verifyAccessToken(token, config)
  } catch (error) {
    logger.error(`Token verification failed: ${errorMessage(error)}`)
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

  const missingScopes = config.requiredScopes.filter(
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
  config: OAuthConfig = defaultConfig,
): Record<string, unknown> {
  return {
    resource: new URL('/', baseUrl).href,
    authorization_servers: [oauthMetadata.issuer],
    scopes_supported: config.requiredScopes,
    resource_name: 'Socket MCP Server',
  }
}

// URL clients should hit (advertised in WWW-Authenticate) to learn the
// resource metadata.
export function getProtectedResourceMetadataUrl(baseUrl: URL): string {
  return new URL(OAUTH_PROTECTED_RESOURCE_METADATA_PATH, baseUrl).href
}

export function isOauthEnabled(): boolean {
  return defaultConfig.enabled
}

// Discover the upstream issuer's authorization-server metadata
// (RFC 8414). The fetched metadata is cached; failures clear the cache so
// the next request retries.
export async function loadOAuthMetadata(
  config: OAuthConfig = defaultConfig,
): Promise<OAuthAuthorizationServerMetadata | undefined> {
  if (!config.enabled) {
    return undefined
  }

  if (!config.metadataPromise) {
    const metadataPromise = (async () => {
      // `enabled` is only set when all three settings were present (see
      // setOauthEnabled / allOAuthConfig), which requires `issuer` to be
      // a non-empty string. SSRF-guard it: an operator-set issuer must not
      // point the discovery request at an internal/loopback host.
      const issuerUrl = assertSafeHttpUrl(
        config.issuer,
        'SOCKET_OAUTH_ISSUER',
        ALLOW_LOCAL_OAUTH,
      )
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
      if (config.metadataPromise === retryableMetadataPromise) {
        config.metadataPromise = undefined
      }

      throw error
    })

    config.metadataPromise = retryableMetadataPromise
  }

  return await config.metadataPromise
}

// Call this in HTTP mode after confirming all three settings are present.
// Returns the SOCKET_OAUTH_ISSUER (for logging) when enabled.
// Build an OAuthConfig from the fleet-canonical env helpers in
// @socketsecurity/lib/env/socket. Centralizing the reads means an env-
// var rename / alias-table change is a single-file edit upstream;
// socket-mcp picks it up on the next dep bump. Tests call this with
// explicit overrides instead of mutating process.env.
export function resolveOAuthConfig(
  overrides: Partial<Omit<OAuthConfig, 'enabled' | 'metadataPromise'>> = {},
): OAuthConfig {
  return {
    issuer: overrides.issuer ?? getSocketOauthIssuer() ?? '',
    introspectionClientId:
      overrides.introspectionClientId ??
      getSocketOauthIntrospectionClientId() ??
      '',
    introspectionClientSecret:
      overrides.introspectionClientSecret ??
      getSocketOauthIntrospectionClientSecret() ??
      '',
    requiredScopes: overrides.requiredScopes ?? getSocketOauthRequiredScopes(),
    metadataPromise: undefined,
    enabled: false,
  }
}

export function setOauthEnabled(): { issuer: string } | undefined {
  if (!allOAuthConfig) {
    return undefined
  }
  defaultConfig.enabled = true
  // `allOAuthConfig` was checked above; issuer is a non-empty string here.
  return { issuer: defaultConfig.issuer }
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
  config: OAuthConfig = defaultConfig,
): Promise<AuthInfo | undefined> {
  const oauthMetadata = await loadOAuthMetadata(config)
  if (!oauthMetadata) {
    throw new Error('OAuth is not configured for this server')
  }

  // The introspection endpoint comes from the issuer's metadata response — a
  // malicious/MITM'd issuer could point it at an internal host. SSRF-guard it
  // before sending the bearer token there.
  const introspectionUrl = assertSafeHttpUrl(
    oauthMetadata.introspection_endpoint,
    'OAuth introspection_endpoint',
    ALLOW_LOCAL_OAUTH,
  ).href
  const response = await httpRequest(introspectionUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${config.introspectionClientId}:${config.introspectionClientSecret}`).toString('base64')}`,
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

  // Resolve the token's expiry from the introspection `exp` claim. A
  // genuinely absent `exp` means a non-expiring token (left off the
  // returned AuthInfo). But a PRESENT-yet-malformed `exp` (a string that
  // doesn't parse, an object, NaN) must fail CLOSED: silently dropping it
  // would treat the token as never-expiring, so a buggy/compromised
  // introspection endpoint could hand out tokens that never age out.
  const rawExp = introspection['exp']
  let expiresAt: number | undefined
  if (rawExp !== undefined && rawExp !== null) {
    const parsed = typeof rawExp === 'number' ? rawExp : Number(rawExp)
    if (!Number.isFinite(parsed)) {
      return undefined
    }
    expiresAt = parsed
  }

  return {
    token,
    clientId:
      typeof introspection['client_id'] === 'string'
        ? introspection['client_id']
        : 'unknown',
    scopes: splitScopes(introspection['scope']),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    extra: introspection,
  }
}
