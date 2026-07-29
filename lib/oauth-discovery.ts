/**
 * @file RFC 8414 authorization-server metadata discovery: building the ordered
 *   well-known probe list for an issuer, fetching and shape-checking a
 *   candidate document, and binding the document's `issuer` to the configured
 *   one before any endpoint in it is used.
 */

import { errorMessage } from '@socketsecurity/lib/errors/message'
import { httpRequest } from '@socketsecurity/lib/http-request/request'

import { assertSafeHttpUrl, parseJsonObject } from './http-helpers.ts'
import { ALLOW_LOCAL_OAUTH, defaultOAuthConfig } from './oauth-config.ts'
import type {
  OAuthAuthorizationServerMetadata,
  OAuthConfig,
} from './oauth-config.ts'

const OAUTH_AUTHORIZATION_SERVER_SEGMENT =
  '/.well-known/oauth-authorization-server'
const OPENID_CONFIGURATION_SEGMENT = '/.well-known/openid-configuration'

// A failed discovery probe quotes the response body back in the aggregate
// error; cap it so one HTML error page can't bury the other probe results.
const MAX_DISCOVERY_ERROR_BODY_CHARS = 200

// The metadata fields discovery must produce, each paired with why it is
// required. The first three are RFC 8414 §2 requirements.
// `introspection_endpoint` is optional in RFC 8414 and OIDC Discovery. It is
// socket-mcp that demands it, because RFC 7662 introspection is this server's
// only way to verify an access token.
const REQUIRED_OAUTH_FIELDS = [
  ['issuer', 'RFC 8414 §2 requires it'],
  ['authorization_endpoint', 'RFC 8414 §2 requires it'],
  ['token_endpoint', 'RFC 8414 §2 requires it'],
  [
    'introspection_endpoint',
    "RFC 8414 leaves it optional, but socket-mcp requires it — RFC 7662 introspection is this server's only token-verification strategy",
  ],
] as const

// The RFC 8414 §3.1 well-known URLs to probe for an issuer, in the order the
// spec prescribes. A path-bearing issuer such as
// `https://auth.example.com/tenant1` inserts the well-known segment BEFORE its
// path so the tenant is preserved, and the OIDC path-appended form is the last
// resort. A path-less issuer has only the two root forms.
export function buildOAuthWellKnownUrls(issuerUrl: URL): string[] {
  const { origin } = issuerUrl
  // A lone '/' is not a path component for insertion purposes; strip a
  // trailing slash so `https://host/tenant1/` and `https://host/tenant1`
  // probe the same URLs.
  const issuerPath = issuerUrl.pathname.replace(/\/+$/u, '')
  if (!issuerPath) {
    return [
      `${origin}${OAUTH_AUTHORIZATION_SERVER_SEGMENT}`,
      `${origin}${OPENID_CONFIGURATION_SEGMENT}`,
    ]
  }
  return [
    `${origin}${OAUTH_AUTHORIZATION_SERVER_SEGMENT}${issuerPath}`,
    `${origin}${OPENID_CONFIGURATION_SEGMENT}${issuerPath}`,
    `${origin}${issuerPath}${OPENID_CONFIGURATION_SEGMENT}`,
  ]
}

// Fetch and shape-check one candidate authorization-server metadata document.
// Throws with the reason on any failure so the discovery probe can record it
// against the URL that produced it.
export async function fetchOAuthMetadataDocument(
  url: string,
): Promise<OAuthAuthorizationServerMetadata> {
  const response = await httpRequest(url)
  const responseText = response.text()

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}: ${responseText.slice(0, MAX_DISCOVERY_ERROR_BODY_CHARS)}`,
    )
  }

  const metadata = parseJsonObject(responseText, 'OAuth metadata discovery')

  validateOAuthMetadataFields(metadata)

  return metadata
}

// Discover the upstream issuer's authorization-server metadata (RFC 8414) by
// probing the spec's well-known URLs in order and taking the first document
// whose own `issuer` matches the configured one. The result is cached;
// failures clear the cache so the next request retries.
export async function loadOAuthMetadata(
  options: OAuthConfig = defaultOAuthConfig,
): Promise<OAuthAuthorizationServerMetadata | undefined> {
  if (!options.enabled) {
    return undefined
  }

  if (!options.metadataPromise) {
    const metadataPromise = (async () => {
      // `enabled` is only set when all three settings were present (see
      // setOauthEnabled / allOAuthConfig), which requires `issuer` to be
      // a non-empty string. SSRF-guard it: an operator-set issuer must not
      // point the discovery request at an internal/loopback host, and on a
      // public host it must be https.
      const issuerUrl = assertSafeHttpUrl(
        options.issuer,
        'SOCKET_OAUTH_ISSUER',
        ALLOW_LOCAL_OAUTH,
      )

      const candidateUrls = buildOAuthWellKnownUrls(issuerUrl)
      const failures: string[] = []

      for (let i = 0, { length } = candidateUrls; i < length; i += 1) {
        const candidateUrl = candidateUrls[i]!
        let metadata: OAuthAuthorizationServerMetadata
        try {
          // Probes are sequential by contract: a later URL is tried only
          // when the earlier one fails to yield a usable document.
          metadata = await fetchOAuthMetadataDocument(candidateUrl)
        } catch (e) {
          failures.push(`${candidateUrl} — ${errorMessage(e)}`)
          continue
        }

        // RFC 8414 §3.3: the document's `issuer` MUST be identical to the
        // issuer used to build the well-known URL, compared with RFC 3986
        // simple string comparison. No scheme or host case folding, no
        // trailing-slash or percent-encoding normalization.
        if (metadata.issuer !== options.issuer) {
          failures.push(
            `${candidateUrl} — issuer mismatch: document declares "${metadata.issuer}", SOCKET_OAUTH_ISSUER is "${options.issuer}"`,
          )
          continue
        }

        return metadata
      }

      throw new Error(
        `OAuth authorization-server discovery found no usable metadata for issuer "${options.issuer}". ` +
          `Tried ${failures.length} well-known URLs: ${failures.join('; ')}. ` +
          'Fix: confirm SOCKET_OAUTH_ISSUER is the exact issuer identifier the authorization server publishes in its metadata document, byte for byte.',
      )
    })()

    const retryableMetadataPromise = metadataPromise.catch(error => {
      if (options.metadataPromise === retryableMetadataPromise) {
        options.metadataPromise = undefined
      }

      throw error
    })

    options.metadataPromise = retryableMetadataPromise
  }

  return await options.metadataPromise
}

// Assert a discovered metadata document carries every field this server needs
// before any of them is used.
export function validateOAuthMetadataFields(
  metadata: Record<string, unknown>,
): asserts metadata is OAuthAuthorizationServerMetadata {
  for (let i = 0, { length } = REQUIRED_OAUTH_FIELDS; i < length; i += 1) {
    const [field, reason] = REQUIRED_OAUTH_FIELDS[i]!
    if (typeof metadata[field] !== 'string' || !metadata[field]) {
      throw new Error(
        `OAuth metadata missing required field: ${field} — ${reason}. Fix: have the authorization server publish ${field} in its metadata document.`,
      )
    }
  }
}
