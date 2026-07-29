import nock from 'nock'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { getRequestBaseUrl } from '../../lib/http-helpers.ts'
import {
  authenticateRequest,
  buildProtectedResourceMetadata,
  getProtectedResourceMetadataUrl,
  splitScopes,
  splitTokenAudience,
  verifyAccessToken,
} from '../../lib/oauth.ts'
import {
  assertOAuthError,
  issuerBaseUrl,
  makeConfig,
  makeMockResponse,
  makeRequest,
  mockDiscovery,
  mockIntrospection,
  otherResource,
  protectedResourceMetadataPath,
  resourceBaseUrl,
  resourceIdentifier,
  resourceMetadataUrl,
} from './oauth-fixtures.mts'

beforeEach(() => {
  nock.disableNetConnect()
})

afterEach(() => {
  nock.cleanAll()
  nock.enableNetConnect()
})

test('splitScopes tokenizes space-delimited scope strings', () => {
  expect(splitScopes('packages:list packages:write')).toEqual([
    'packages:list',
    'packages:write',
  ])
  expect(splitScopes('  packages:list   ')).toEqual(['packages:list'])
  expect(splitScopes('')).toEqual([])
  expect(splitScopes(undefined)).toEqual([])
  expect(splitScopes(42)).toEqual([])
})

test('splitTokenAudience reads the string and array forms of aud', () => {
  expect(splitTokenAudience(resourceIdentifier.href)).toEqual([
    resourceIdentifier.href,
  ])
  expect(splitTokenAudience([otherResource, resourceIdentifier.href])).toEqual([
    otherResource,
    resourceIdentifier.href,
  ])
  expect(splitTokenAudience([1, otherResource, ''])).toEqual([otherResource])
  expect(splitTokenAudience('   ')).toEqual([])
  expect(splitTokenAudience(undefined)).toEqual([])
  expect(splitTokenAudience({ aud: otherResource })).toEqual([])
})

test('buildProtectedResourceMetadata publishes the configured issuer', () => {
  const metadata = buildProtectedResourceMetadata(resourceBaseUrl, makeConfig())
  expect(metadata['resource']).toBe('https://resource.example.test/')
  expect(metadata['authorization_servers']).toEqual([issuerBaseUrl])
  expect(metadata['scopes_supported']).toEqual(['packages:list'])
  expect(metadata['bearer_methods_supported']).toEqual(['header'])
})

test('buildProtectedResourceMetadata drops offline_access from scopes_supported', () => {
  const metadata = buildProtectedResourceMetadata(
    resourceBaseUrl,
    makeConfig({ requiredScopes: ['offline_access', 'packages:list'] }),
  )
  expect(metadata['scopes_supported']).toEqual(['packages:list'])
})

test('getProtectedResourceMetadataUrl builds the well-known URL', () => {
  expect(getProtectedResourceMetadataUrl(resourceBaseUrl)).toBe(
    `https://resource.example.test${protectedResourceMetadataPath}`,
  )
})

test('getRequestBaseUrl ignores forwarded headers unless trustProxy', () => {
  const req = makeRequest(undefined, {
    host: 'observed.example.test:1234',
    'x-forwarded-host': 'proxy.example.com',
    'x-forwarded-proto': 'https',
  })
  expect(getRequestBaseUrl(req, 3000, false).href).toBe(
    'http://observed.example.test:1234/',
  )
  expect(getRequestBaseUrl(req, 3000, true).href).toBe(
    'https://proxy.example.com/',
  )
})

test('verifyAccessToken returns undefined for an inactive token', async () => {
  mockDiscovery()
  mockIntrospection()
  expect(
    await verifyAccessToken('inactive-token', resourceIdentifier, makeConfig()),
  ).toBe(undefined)
})

test('verifyAccessToken maps an active introspection to AuthInfo', async () => {
  mockDiscovery()
  mockIntrospection()
  const authInfo = await verifyAccessToken(
    'token-without-exp',
    resourceIdentifier,
    makeConfig(),
  )
  expect(authInfo?.clientId).toBe('oauth-test-client')
  expect(authInfo?.scopes).toEqual(['packages:list'])
  // Absent exp → non-expiring token: expiresAt left off the AuthInfo.
  expect(authInfo?.expiresAt).toBe(undefined)
  // The token named this resource, so the binding is recorded.
  expect(authInfo?.resource?.href).toBe(resourceIdentifier.href)
})

test('verifyAccessToken preserves a valid numeric exp', async () => {
  mockDiscovery()
  mockIntrospection()
  const authInfo = await verifyAccessToken(
    'token-with-valid-exp',
    resourceIdentifier,
    makeConfig(),
  )
  expect(authInfo?.expiresAt).toBe(4_102_444_800)
})

test('verifyAccessToken fails closed on a malformed exp (never-expiring guard)', async () => {
  mockDiscovery()
  mockIntrospection()
  // A present-but-unparseable exp must reject the token, not silently
  // strip the expiry and accept it as non-expiring.
  const authInfo = await verifyAccessToken(
    'token-with-malformed-exp',
    resourceIdentifier,
    makeConfig(),
  )
  expect(authInfo).toBe(undefined)
})

test('verifyAccessToken falls back to an unknown clientId for a non-string client_id', async () => {
  mockDiscovery()
  mockIntrospection()
  const authInfo = await verifyAccessToken(
    'token-with-nonstring-client-id',
    resourceIdentifier,
    makeConfig(),
  )
  expect(authInfo?.clientId).toBe('unknown')
})

test('verifyAccessToken refuses to introspect when OAuth is not enabled', async () => {
  // Discovery short-circuits on a disabled config, so there is no metadata
  // and no endpoint to send the bearer token to.
  await expect(
    verifyAccessToken(
      'token-without-exp',
      resourceIdentifier,
      makeConfig({ enabled: false }),
    ),
  ).rejects.toThrow('OAuth is not configured for this server')
})

test('verifyAccessToken surfaces a non-2xx introspection response', async () => {
  mockDiscovery()
  nock(issuerBaseUrl).post('/introspect').reply(503, 'introspection is down')
  await expect(
    verifyAccessToken('any-token', resourceIdentifier, makeConfig()),
  ).rejects.toThrow(
    'Token introspection failed with status 503: introspection is down',
  )
})

test('verifyAccessToken rejects a token minted for another resource', async () => {
  mockDiscovery()
  mockIntrospection()
  const authInfo = await verifyAccessToken(
    'token-for-another-resource',
    resourceIdentifier,
    makeConfig(),
  )
  expect(authInfo).toBe(undefined)
})

test('verifyAccessToken accepts an array aud that contains this resource', async () => {
  mockDiscovery()
  mockIntrospection()
  const authInfo = await verifyAccessToken(
    'token-with-array-aud',
    resourceIdentifier,
    makeConfig(),
  )
  expect(authInfo?.clientId).toBe('oauth-test-client')
  expect(authInfo?.resource?.href).toBe(resourceIdentifier.href)
})

test('verifyAccessToken rejects an opaque non-URL aud', async () => {
  mockDiscovery()
  mockIntrospection()
  // An audience that is not a URL can never name a URL resource identifier;
  // it must fail closed rather than throw out of the URL parser.
  const authInfo = await verifyAccessToken(
    'token-with-opaque-aud',
    resourceIdentifier,
    makeConfig(),
  )
  expect(authInfo).toBe(undefined)
})

test('verifyAccessToken accepts a missing aud by default and leaves resource unbound', async () => {
  mockDiscovery()
  mockIntrospection()
  const authInfo = await verifyAccessToken(
    'token-without-aud',
    resourceIdentifier,
    makeConfig(),
  )
  expect(authInfo?.clientId).toBe('oauth-test-client')
  // No audience was asserted, so none is synthesized onto the AuthInfo.
  expect(authInfo?.resource).toBe(undefined)
})

test('verifyAccessToken rejects a missing aud under SOCKET_OAUTH_REQUIRE_AUDIENCE', async () => {
  vi.stubEnv('SOCKET_OAUTH_REQUIRE_AUDIENCE', 'true')
  vi.resetModules()
  try {
    // The strict flag is read once at module init, so the strict position
    // needs a freshly-evaluated module.
    const strict = await import('../../lib/oauth.ts')
    const config = strict.resolveOAuthConfig({
      issuer: issuerBaseUrl,
      introspectionClientId: 'oauth-test-client-id',
      introspectionClientSecret: 'oauth-test-client-secret',
      requiredScopes: ['packages:list'],
    })
    config.enabled = true
    mockDiscovery()
    mockIntrospection()
    expect(
      await strict.verifyAccessToken(
        'token-without-aud',
        resourceIdentifier,
        config,
      ),
    ).toBe(undefined)
  } finally {
    vi.unstubAllEnvs()
    vi.resetModules()
  }
})

test('setOauthEnabled refuses a partial OAuth config', async () => {
  // Two of the three settings present is a misconfiguration, not an opt-in:
  // enabling on it would leave the server unable to introspect anything.
  vi.stubEnv('SOCKET_OAUTH_ISSUER', issuerBaseUrl)
  vi.stubEnv('SOCKET_OAUTH_INTROSPECTION_CLIENT_ID', 'oauth-test-client-id')
  vi.stubEnv('SOCKET_OAUTH_INTROSPECTION_CLIENT_SECRET', '')
  vi.resetModules()
  try {
    const partial = await import('../../lib/oauth.ts')
    expect(partial.setOauthEnabled()).toBe(undefined)
    expect(partial.isOauthEnabled()).toBe(false)
  } finally {
    vi.unstubAllEnvs()
    vi.resetModules()
  }
})

test('authenticateRequest rejects a missing Authorization header', async () => {
  const captured = makeMockResponse()
  const result = await authenticateRequest(
    makeRequest(),
    captured.res,
    resourceBaseUrl,
    makeConfig(),
  )
  expect(result.ok).toBe(false)
  assertOAuthError(captured, resourceMetadataUrl, {
    status: 401,
    error: 'invalid_request',
    errorDescription: 'Missing Authorization header',
  })
})

test('authenticateRequest rejects a malformed Authorization header', async () => {
  const captured = makeMockResponse()
  const result = await authenticateRequest(
    makeRequest('Basic abc123'),
    captured.res,
    resourceBaseUrl,
    makeConfig(),
  )
  expect(result.ok).toBe(false)
  assertOAuthError(captured, resourceMetadataUrl, {
    status: 401,
    error: 'invalid_request',
    errorDescription:
      "Invalid Authorization header format, expected 'Bearer TOKEN'",
  })
})

test('authenticateRequest returns invalid_token for an inactive token', async () => {
  mockDiscovery()
  mockIntrospection()
  const captured = makeMockResponse()
  const result = await authenticateRequest(
    makeRequest('Bearer inactive-token'),
    captured.res,
    resourceBaseUrl,
    makeConfig(),
  )
  expect(result.ok).toBe(false)
  assertOAuthError(captured, resourceMetadataUrl, {
    status: 401,
    error: 'invalid_token',
    errorDescription: 'Invalid or expired token',
  })
})

test('authenticateRequest returns insufficient_scope when scopes are missing', async () => {
  mockDiscovery()
  mockIntrospection()
  const captured = makeMockResponse()
  const result = await authenticateRequest(
    makeRequest('Bearer token-with-wrong-scope'),
    captured.res,
    resourceBaseUrl,
    makeConfig(),
  )
  expect(result.ok).toBe(false)
  assertOAuthError(captured, resourceMetadataUrl, {
    status: 403,
    error: 'insufficient_scope',
    errorDescription: 'Missing required scopes: packages:list',
  })
})

test('authenticateRequest accepts an active token even without exp', async () => {
  mockDiscovery()
  mockIntrospection()
  const captured = makeMockResponse()
  const result = await authenticateRequest(
    makeRequest('Bearer token-without-exp'),
    captured.res,
    resourceBaseUrl,
    makeConfig(),
  )
  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(result.authInfo.scopes).toEqual(['packages:list'])
  }
})

test('authenticateRequest rejects a token whose exp has passed', async () => {
  mockDiscovery()
  mockIntrospection()
  const captured = makeMockResponse()
  // Introspection still calls it active; the request-time expiry check is
  // what turns it away.
  const result = await authenticateRequest(
    makeRequest('Bearer token-with-past-exp'),
    captured.res,
    resourceBaseUrl,
    makeConfig(),
  )
  expect(result.ok).toBe(false)
  assertOAuthError(captured, resourceMetadataUrl, {
    status: 401,
    error: 'invalid_token',
    errorDescription: 'Token has expired',
  })
})

test('authenticateRequest 500s when introspection answers non-2xx', async () => {
  mockDiscovery()
  nock(issuerBaseUrl).post('/introspect').reply(502, 'bad gateway')
  const captured = makeMockResponse()
  const result = await authenticateRequest(
    makeRequest('Bearer any-token'),
    captured.res,
    resourceBaseUrl,
    makeConfig(),
  )
  expect(result.ok).toBe(false)
  expect(captured.getStatus()).toBe(500)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
  const body = JSON.parse(captured.getBody()) as {
    error_description?: string | undefined
  }
  expect(body.error_description).toBe('Token verification failed')
})

test('authenticateRequest challenges a token minted for another resource', async () => {
  mockDiscovery()
  mockIntrospection()
  const captured = makeMockResponse()
  const result = await authenticateRequest(
    makeRequest('Bearer token-for-another-resource'),
    captured.res,
    resourceBaseUrl,
    makeConfig(),
  )
  expect(result.ok).toBe(false)
  assertOAuthError(captured, resourceMetadataUrl, {
    status: 401,
    error: 'invalid_token',
    errorDescription: 'Invalid or expired token',
  })
})

test('authenticateRequest 500s when introspection discovery fails', async () => {
  nock(issuerBaseUrl)
    .get('/.well-known/oauth-authorization-server')
    .reply(500, 'boom')
  const captured = makeMockResponse()
  const result = await authenticateRequest(
    makeRequest('Bearer any-token'),
    captured.res,
    resourceBaseUrl,
    makeConfig(),
  )
  expect(result.ok).toBe(false)
  expect(captured.getStatus()).toBe(500)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
  const body = JSON.parse(captured.getBody()) as { error?: string | undefined }
  expect(body.error).toBe('server_error')
})
