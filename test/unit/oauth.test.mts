import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'

import nock from 'nock'
import { afterEach, beforeEach, expect, test } from 'vitest'

import {
  authenticateRequest,
  buildProtectedResourceMetadata,
  getProtectedResourceMetadataUrl,
  loadOAuthMetadata,
  resolveOAuthConfig,
  splitScopes,
  validateOAuthMetadataFields,
  verifyAccessToken,
} from '../../lib/oauth.ts'
import type { OAuthConfig } from '../../lib/oauth.ts'
import { getRequestBaseUrl } from '../../lib/http-helpers.ts'

const oauthWellKnownPath = '/.well-known/oauth-authorization-server'
const protectedResourceMetadataPath = '/.well-known/oauth-protected-resource'

const issuerBaseUrl = 'https://issuer.example.test'
const introspectionPath = '/introspect'

// In-process introspection responses keyed by token, mirroring the
// fixtures the upstream introspection endpoint would return.
const mockIntrospectionResponses: Record<string, Record<string, unknown>> = {
  'token-with-malformed-exp': {
    active: true,
    client_id: 'oauth-test-client',
    // A present-but-non-numeric `exp` must fail closed — silently dropping
    // it would treat the token as never-expiring.
    exp: 'not-a-number',
    scope: 'packages:list',
  },
  'token-with-valid-exp': {
    active: true,
    client_id: 'oauth-test-client',
    exp: 4_102_444_800,
    scope: 'packages:list',
  },
  'token-with-wrong-scope': {
    active: true,
    client_id: 'oauth-test-client',
    scope: 'packages:write',
  },
  'token-without-exp': {
    active: true,
    client_id: 'oauth-test-client',
    scope: 'packages:list',
  },
}

export function assertOAuthError(
  captured: CapturedResponse,
  resourceMetadataUrl: string,
  expected: {
    status: number
    error: string
    errorDescription: string
  },
): void {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
  const body = JSON.parse(captured.getBody()) as {
    error?: string | undefined
    error_description?: string | undefined
  }
  assert.equal(captured.getStatus(), expected.status)
  assert.equal(body.error, expected.error)
  assert.equal(body.error_description, expected.errorDescription)
  assert.equal(
    captured.getHeaders()['WWW-Authenticate'],
    `Bearer error="${expected.error}", error_description="${expected.errorDescription}", resource_metadata="${resourceMetadataUrl}"`,
  )
}

// Build an enabled OAuthConfig pointed at the nock-mocked issuer. Each
// call gets a fresh config so the per-config discovery cache is isolated.
export function makeConfig(overrides: Partial<OAuthConfig> = {}): OAuthConfig {
  const config = resolveOAuthConfig({
    issuer: issuerBaseUrl,
    introspectionClientId: 'oauth-test-client-id',
    introspectionClientSecret: 'oauth-test-client-secret',
    requiredScopes: ['packages:list'],
  })
  config.enabled = true
  return Object.assign(config, overrides)
}

// Capture status / headers / body written via writeHead + end so the
// ServerResponse-driven authenticateRequest can be asserted in-process.
interface CapturedResponse {
  res: ServerResponse
  getStatus: () => number
  getHeaders: () => Record<string, string>
  getBody: () => string
}

export function makeMockResponse(): CapturedResponse {
  let status = 0
  let headers: Record<string, string> = {}
  let body = ''
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
  const res = {
    writeHead(statusCode: number, responseHeaders?: Record<string, string>) {
      status = statusCode
      if (responseHeaders) {
        headers = { ...responseHeaders }
      }
      return res
    },
    end(chunk?: string) {
      if (typeof chunk === 'string') {
        body += chunk
      }
      return res
    },
  } as unknown as ServerResponse
  return {
    res,
    getStatus: () => status,
    getHeaders: () => headers,
    getBody: () => body,
  }
}

// Build a minimal IncomingMessage with the given Authorization header.
export function makeRequest(
  authorization?: string,
  extraHeaders: Record<string, string> = {},
): IncomingMessage {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
  return {
    headers: {
      ...(authorization === undefined ? {} : { authorization }),
      ...extraHeaders,
    },
    socket: new Socket(),
  } as unknown as IncomingMessage
}

// Mock the RFC 8414 discovery endpoint so loadOAuthMetadata resolves
// without a live issuer.
export function mockDiscovery(): void {
  nock(issuerBaseUrl)
    .get(oauthWellKnownPath)
    .reply(200, {
      issuer: issuerBaseUrl,
      authorization_endpoint: `${issuerBaseUrl}/authorize`,
      token_endpoint: `${issuerBaseUrl}/token`,
      introspection_endpoint: `${issuerBaseUrl}${introspectionPath}`,
    })
}

// Mock the RFC 7662 introspection endpoint, replying based on the posted
// token. nock 15 emits the scope's 'request' event (with the raw body
// string) before playback, so the token is captured there and the reply
// function stays zero-arg — a 2-arg reply function gets util.promisify'd
// under nock 15 and hangs forever.
export function mockIntrospection(): void {
  let token: string | null = null
  const scope = nock(issuerBaseUrl)
  scope.on('request', (_req, _interceptor, body) => {
    token = new URLSearchParams(String(body)).get('token')
  })
  scope.post(introspectionPath).reply(() => {
    const response = token ? mockIntrospectionResponses[token] : undefined
    return [200, JSON.stringify(response || { active: false })]
  })
}

const resourceMetadataUrl = `https://resource.example.test${protectedResourceMetadataPath}`

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

test('validateOAuthMetadataFields requires the RFC 8414 fields', () => {
  const valid = {
    issuer: issuerBaseUrl,
    authorization_endpoint: `${issuerBaseUrl}/authorize`,
    token_endpoint: `${issuerBaseUrl}/token`,
    introspection_endpoint: `${issuerBaseUrl}${introspectionPath}`,
  }
  expect(() => validateOAuthMetadataFields({ ...valid })).not.toThrow()
  expect(() => {
    const { token_endpoint: _omit, ...missing } = valid
    validateOAuthMetadataFields(missing)
  }).toThrow(/missing required field: token_endpoint/)
})

test('buildProtectedResourceMetadata points clients at the issuer', () => {
  const config = makeConfig()
  const metadata = buildProtectedResourceMetadata(
    new URL('https://resource.example.test/'),
    {
      issuer: issuerBaseUrl,
      authorization_endpoint: `${issuerBaseUrl}/authorize`,
      token_endpoint: `${issuerBaseUrl}/token`,
      introspection_endpoint: `${issuerBaseUrl}${introspectionPath}`,
    },
    config,
  )
  expect(metadata['resource']).toBe('https://resource.example.test/')
  expect(metadata['authorization_servers']).toEqual([issuerBaseUrl])
  expect(metadata['scopes_supported']).toEqual(['packages:list'])
})

test('getProtectedResourceMetadataUrl builds the well-known URL', () => {
  expect(
    getProtectedResourceMetadataUrl(new URL('https://resource.example.test/')),
  ).toBe(`https://resource.example.test${protectedResourceMetadataPath}`)
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

test('loadOAuthMetadata returns undefined when the config is disabled', async () => {
  const config = makeConfig({ enabled: false })
  expect(await loadOAuthMetadata(config)).toBe(undefined)
})

test('loadOAuthMetadata discovers and caches issuer metadata', async () => {
  mockDiscovery()
  const config = makeConfig()
  const metadata = await loadOAuthMetadata(config)
  expect(metadata?.introspection_endpoint).toBe(
    `${issuerBaseUrl}${introspectionPath}`,
  )
  // Second call is served from the per-config cache — no new nock mock
  // is registered, so a live request would fail under disableNetConnect.
  const cached = await loadOAuthMetadata(config)
  expect(cached).toBe(metadata)
})

test('loadOAuthMetadata clears the cache on discovery failure', async () => {
  nock(issuerBaseUrl).get(oauthWellKnownPath).reply(500, 'boom')
  const config = makeConfig()
  await expect(loadOAuthMetadata(config)).rejects.toThrow(
    /OAuth metadata discovery failed with status 500/,
  )
  // Cache was cleared, so a retry re-requests — succeed this time.
  mockDiscovery()
  const metadata = await loadOAuthMetadata(config)
  expect(metadata?.issuer).toBe(issuerBaseUrl)
})

test('verifyAccessToken returns undefined for an inactive token', async () => {
  mockDiscovery()
  mockIntrospection()
  const config = makeConfig()
  expect(await verifyAccessToken('inactive-token', config)).toBe(undefined)
})

test('verifyAccessToken maps an active introspection to AuthInfo', async () => {
  mockDiscovery()
  mockIntrospection()
  const config = makeConfig()
  const authInfo = await verifyAccessToken('token-without-exp', config)
  expect(authInfo?.clientId).toBe('oauth-test-client')
  expect(authInfo?.scopes).toEqual(['packages:list'])
  // Absent exp → non-expiring token: expiresAt left off the AuthInfo.
  expect(authInfo?.expiresAt).toBe(undefined)
})

test('verifyAccessToken preserves a valid numeric exp', async () => {
  mockDiscovery()
  mockIntrospection()
  const authInfo = await verifyAccessToken('token-with-valid-exp', makeConfig())
  expect(authInfo?.expiresAt).toBe(4_102_444_800)
})

test('verifyAccessToken fails closed on a malformed exp (never-expiring guard)', async () => {
  mockDiscovery()
  mockIntrospection()
  // A present-but-unparseable exp must reject the token, not silently
  // strip the expiry and accept it as non-expiring.
  const authInfo = await verifyAccessToken(
    'token-with-malformed-exp',
    makeConfig(),
  )
  expect(authInfo).toBe(undefined)
})

test('authenticateRequest rejects a missing Authorization header', async () => {
  const captured = makeMockResponse()
  const result = await authenticateRequest(
    makeRequest(),
    captured.res,
    resourceMetadataUrl,
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
    resourceMetadataUrl,
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
    resourceMetadataUrl,
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
    resourceMetadataUrl,
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
    resourceMetadataUrl,
    makeConfig(),
  )
  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(result.authInfo.scopes).toEqual(['packages:list'])
  }
})

test('authenticateRequest 500s when introspection discovery fails', async () => {
  nock(issuerBaseUrl).get(oauthWellKnownPath).reply(500, 'boom')
  const captured = makeMockResponse()
  const result = await authenticateRequest(
    makeRequest('Bearer any-token'),
    captured.res,
    resourceMetadataUrl,
    makeConfig(),
  )
  expect(result.ok).toBe(false)
  expect(captured.getStatus()).toBe(500)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
  const body = JSON.parse(captured.getBody()) as { error?: string | undefined }
  expect(body.error).toBe('server_error')
})
