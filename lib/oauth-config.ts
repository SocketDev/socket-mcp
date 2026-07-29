/**
 * @file Resolved OAuth settings for the resource server: the env-derived
 *   module default, the per-config discovery cache it carries, and the scope
 *   list this resource advertises. Discovery lives in `oauth-discovery.ts`;
 *   the request-time bearer pipeline lives in `oauth.ts`.
 */

import { getSocketDebug } from '@socketsecurity/lib/env/socket'
import { envAsBoolean } from '@socketsecurity/lib-stable/env/boolean'

import {
  getSocketOauthIntrospectionClientId,
  getSocketOauthIntrospectionClientSecret,
  getSocketOauthIssuer,
  getSocketOauthRequireAudience,
  getSocketOauthRequiredScopes,
} from './env.ts'

// In SOCKET_DEBUG local-stack mode the issuer/introspection endpoints may be
// on localhost over plain http; otherwise loopback/private hosts are refused
// as SSRF targets and a public host must be https.
export const ALLOW_LOCAL_OAUTH: boolean = envAsBoolean(getSocketDebug())

// Strict RFC 8707 audience enforcement: reject a token whose introspection
// response carries no `aud` at all. Off by default, because an authorization
// server that does not emit `aud` would otherwise fail every request. A
// PRESENT `aud` naming another resource is rejected either way.
export const REQUIRE_OAUTH_AUDIENCE: boolean = getSocketOauthRequireAudience()

// RFC 6749 §3.3 reserves no meaning for `offline_access`. It is an OIDC
// refresh-token request scope, not something a resource server requires of an
// access token, so it never reaches `scopes_supported`.
const NON_RESOURCE_SCOPES = new Set(['offline_access'])

export interface OAuthAuthorizationServerMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  introspection_endpoint: string
  [key: string]: unknown
}

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
export const defaultOAuthConfig: OAuthConfig = resolveOAuthConfig()

// The required scopes the resource advertises.
export const SOCKET_OAUTH_REQUIRED_SCOPES: string[] =
  defaultOAuthConfig.requiredScopes

// True when ANY of the three introspection settings are configured —
// caller uses this to detect partial / incomplete configs and refuse to
// start.
export const hasAnyOAuthConfig: boolean = Boolean(
  defaultOAuthConfig.introspectionClientId ||
  defaultOAuthConfig.introspectionClientSecret ||
  defaultOAuthConfig.issuer,
)

const allOAuthConfig = Boolean(
  defaultOAuthConfig.introspectionClientId &&
  defaultOAuthConfig.introspectionClientSecret &&
  defaultOAuthConfig.issuer,
)

// The `scope` parameter for a WWW-Authenticate challenge: the space-delimited
// list of scopes this resource requires. Empty when no scope is enforced, in
// which case the challenge omits the parameter.
export function buildOAuthScopeParameter(
  options: OAuthConfig = defaultOAuthConfig,
): string {
  return buildResourceScopes(options).join(' ')
}

// The scopes this resource advertises and enforces: the operator's configured
// list minus scopes that are meaningless on a resource server.
export function buildResourceScopes(
  options: OAuthConfig = defaultOAuthConfig,
): string[] {
  return options.requiredScopes.filter(scope => !NON_RESOURCE_SCOPES.has(scope))
}

export function isOauthEnabled(): boolean {
  return defaultOAuthConfig.enabled
}

// Build an OAuthConfig from the fleet-canonical env helpers. Centralizing the
// reads means an env-var rename / alias-table change is a single-file edit
// upstream; socket-mcp picks it up on the next dep bump. Tests call this with
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

// Call this in HTTP mode after confirming all three settings are present.
// Returns the SOCKET_OAUTH_ISSUER for logging when enabled.
export function setOauthEnabled(): { issuer: string } | undefined {
  if (!allOAuthConfig) {
    return undefined
  }
  defaultOAuthConfig.enabled = true
  // `allOAuthConfig` was checked above; issuer is a non-empty string here.
  return { issuer: defaultOAuthConfig.issuer }
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
