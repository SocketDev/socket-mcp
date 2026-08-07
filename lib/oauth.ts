/**
 * @file The request-time OAuth surface: the bearer-token pipeline incoming MCP
 *   requests run through, RFC 7662 introspection with RFC 8707 audience
 *   validation, and the RFC 9728 protected-resource metadata this server
 *   publishes. Settings live in `oauth-config.ts`, discovery in
 *   `oauth-discovery.ts`.
 */

import {
  checkResourceAllowed,
  resourceUrlFromServerUrl,
} from '@modelcontextprotocol/server'
import type { AuthInfo } from '@modelcontextprotocol/server'
import { errorMessage } from '@socketsecurity/lib/errors/message'
import { httpRequest } from '@socketsecurity/lib/http-request/request'
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  assertSafeHttpUrl,
  getRequestHeaderValue,
  parseJsonObject,
  writeJson,
  writeOAuthError,
} from './http-helpers.ts'
import { logger } from './logger.ts'
import {
  ALLOW_LOCAL_OAUTH,
  buildOAuthScopeParameter,
  buildResourceScopes,
  defaultOAuthConfig,
  REQUIRE_OAUTH_AUDIENCE,
  splitScopes,
} from './oauth-config.ts'
import type { OAuthConfig } from './oauth-config.ts'
import { loadOAuthMetadata } from './oauth-discovery.ts'

export {
  buildOAuthScopeParameter,
  buildResourceScopes,
  hasAnyOAuthConfig,
  isOauthEnabled,
  resolveOAuthConfig,
  setOauthEnabled,
  SOCKET_OAUTH_REQUIRED_SCOPES,
  splitScopes,
} from './oauth-config.ts'
export type {
  OAuthAuthorizationServerMetadata,
  OAuthConfig,
} from './oauth-config.ts'
export {
  buildOAuthWellKnownUrls,
  fetchOAuthMetadataDocument,
  loadOAuthMetadata,
  validateOAuthMetadataFields,
} from './oauth-discovery.ts'

// The MCP Node adapter reads `{ auth?: AuthInfo }` off the request (no
// `| undefined`). Adding `| undefined` would satisfy our internal
// `optional-explicit-undefined` lint rule but break the structural
// match required by the SDK under `exactOptionalPropertyTypes: true`.
// Third-party shape wins.
// oxlint-disable-next-line socket/optional-explicit-undefined -- must match @modelcontextprotocol/node's AuthInfo container shape.
export type AuthenticatedRequest = IncomingMessage & { auth?: AuthInfo }

export const OAUTH_PROTECTED_RESOURCE_METADATA_PATH =
  '/.well-known/oauth-protected-resource'

// Run the bearer-token validation pipeline for incoming MCP requests:
// presence check → format check → introspection → audience → expiry → scope
// check. Each failure step emits the matching RFC 6750 / RFC 7662 error.
export async function authenticateRequest(
  req: AuthenticatedRequest,
  res: ServerResponse,
  baseUrl: URL,
  options: OAuthConfig = defaultOAuthConfig,
): Promise<{ ok: false } | { ok: true; authInfo: AuthInfo }> {
  // Both values derive from the same request base URL that
  // `buildProtectedResourceMetadata` publishes from, so the audience this
  // request is checked against is exactly the `resource` clients discover.
  const resourceMetadataUrl = getProtectedResourceMetadataUrl(baseUrl)
  const resourceIdentifier = getOAuthResourceIdentifier(baseUrl)
  const scope = buildOAuthScopeParameter(options)

  const authHeader = getRequestHeaderValue(req.headers.authorization).trim()
  if (!authHeader) {
    writeOAuthError(
      res,
      401,
      'invalid_request',
      'Missing Authorization header',
      resourceMetadataUrl,
      scope,
    )
    return { ok: false }
  }

  // `authHeader` is trimmed and non-empty, so splitting on whitespace always
  // yields a non-empty first element.
  const [type, token] = authHeader.split(/\s+/u)
  if (type!.toLowerCase() !== 'bearer' || !token) {
    writeOAuthError(
      res,
      401,
      'invalid_request',
      "Invalid Authorization header format, expected 'Bearer TOKEN'",
      resourceMetadataUrl,
      scope,
    )
    return { ok: false }
  }

  let authInfo: AuthInfo | undefined
  try {
    authInfo = await verifyAccessToken(token, resourceIdentifier, options)
  } catch (e) {
    logger.error(`Token verification failed: ${errorMessage(e)}`)
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
      scope,
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
      scope,
    )
    return { ok: false }
  }

  const missingScopes = options.requiredScopes.filter(
    required => !authInfo.scopes.includes(required),
  )
  if (missingScopes.length > 0) {
    writeOAuthError(
      res,
      403,
      'insufficient_scope',
      `Missing required scopes: ${missingScopes.join(', ')}`,
      resourceMetadataUrl,
      scope,
    )
    return { ok: false }
  }

  req.auth = authInfo
  return {
    ok: true,
    authInfo,
  }
}

// RFC 9728 protected-resource metadata. `authorization_servers` publishes the
// CONFIGURED issuer: discovery has already refused any document whose own
// `issuer` differs, so config and document agree and sourcing from config
// makes that invariant plain. `bearer_methods_supported` names only `header`
// because the Authorization header is the sole form this server reads.
export function buildProtectedResourceMetadata(
  baseUrl: URL,
  options: OAuthConfig = defaultOAuthConfig,
): Record<string, unknown> {
  return {
    resource: getOAuthResourceIdentifier(baseUrl).href,
    authorization_servers: [options.issuer],
    scopes_supported: buildResourceScopes(options),
    bearer_methods_supported: ['header'],
    resource_name: 'Socket MCP Server',
  }
}

// The RFC 8707 resource identifier this server answers for. Derived from the
// request's base URL so it matches the `resource` value
// `buildProtectedResourceMetadata` publishes — the audience check and the
// published identifier cannot drift because they call the same function.
export function getOAuthResourceIdentifier(baseUrl: URL): URL {
  return resourceUrlFromServerUrl(new URL('/', baseUrl))
}

// URL clients should hit (advertised in WWW-Authenticate) to learn the
// resource metadata.
export function getProtectedResourceMetadataUrl(baseUrl: URL): string {
  return new URL(OAUTH_PROTECTED_RESOURCE_METADATA_PATH, baseUrl).href
}

// Whether one `aud` entry names this resource server. An audience that is not
// a URL at all can never match a URL resource identifier, so an unparseable
// value fails closed rather than throwing.
export function isOAuthAudienceAllowed(
  audience: string,
  resourceIdentifier: URL,
): boolean {
  try {
    return checkResourceAllowed({
      requestedResource: audience,
      configuredResource: resourceIdentifier,
    })
  } catch {
    return false
  }
}

// Read the RFC 7662 `aud` claim, which is a single string or an array of
// strings, into a list of non-empty audience values.
export function splitTokenAudience(audience: unknown): string[] {
  if (typeof audience === 'string') {
    return audience.trim() ? [audience] : []
  }
  if (Array.isArray(audience)) {
    return audience.filter(
      (value): value is string =>
        typeof value === 'string' && Boolean(value.trim()),
    )
  }
  return []
}

// RFC 7662 token introspection — POST the bearer token to the upstream
// introspection endpoint using HTTP Basic auth for the introspection
// client. Returns AuthInfo on `active:true` whose audience names
// `resourceIdentifier`, undefined on anything else.
export async function verifyAccessToken(
  token: string,
  resourceIdentifier: URL,
  options: OAuthConfig = defaultOAuthConfig,
): Promise<AuthInfo | undefined> {
  const oauthMetadata = await loadOAuthMetadata(options)
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
      authorization: `Basic ${Buffer.from(`${options.introspectionClientId}:${options.introspectionClientSecret}`).toString('base64')}`,
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

  // RFC 8707 §2 / MCP: a token that names an audience is only usable here if
  // that audience is this resource. A PRESENT `aud` naming something else is
  // always rejected. That is the substitution attack, and no flag opens it.
  // An ABSENT `aud` is accepted unless SOCKET_OAUTH_REQUIRE_AUDIENCE is on,
  // because an authorization server that never emits the claim would
  // otherwise fail every request.
  // The flip below is a spec MUST held open only by an upstream dependency:
  // once Socket's authorization server reports `aud` at introspection (#201),
  // SOCKET_OAUTH_REQUIRE_AUDIENCE defaults to on and the accept-when-absent
  // branch below goes away. Flipping it before then rejects every live OAuth
  // request.
  const audiences = splitTokenAudience(introspection['aud'])
  if (audiences.length === 0) {
    if (REQUIRE_OAUTH_AUDIENCE) {
      logger.warn(
        `Rejected an active token carrying no "aud" claim. Where: introspection of a request for ${resourceIdentifier.href}. Saw no audience, wanted one naming this resource. Fix: have the authorization server return "aud" on introspection, or unset SOCKET_OAUTH_REQUIRE_AUDIENCE to accept audience-less tokens.`,
      )
      return undefined
    }
  } else if (
    !audiences.some(audience =>
      isOAuthAudienceAllowed(audience, resourceIdentifier),
    )
  ) {
    logger.warn(
      `Rejected a token minted for another resource. Where: introspection of a request for ${resourceIdentifier.href}. Saw aud=[${audiences.join(', ')}], wanted ${resourceIdentifier.href}. Fix: request the token with resource=${resourceIdentifier.href}.`,
    )
    return undefined
  }

  // Resolve the token's expiry from the introspection `exp` claim. A
  // genuinely absent `exp` means a non-expiring token, left off the
  // returned AuthInfo. But a PRESENT-yet-malformed `exp` — a string that
  // doesn't parse, an object, NaN — must fail CLOSED: silently dropping it
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
    // Bound only when the token actually named an audience that matched.
    // Synthesizing one for an audience-less token would claim a binding the
    // authorization server never asserted.
    ...(audiences.length > 0 ? { resource: resourceIdentifier } : {}),
    extra: introspection,
  }
}
