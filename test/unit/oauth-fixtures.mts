/**
 * @file Shared OAuth test doubles for the unit suites: the nock-mocked issuer
 *   (discovery + RFC 7662 introspection), an enabled OAuthConfig pointed at it,
 *   and the ServerResponse capture `authenticateRequest` writes into. Not a
 *   `*.test.mts` file, so vitest imports it rather than collecting it.
 */

import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'

import nock from 'nock'

import {
  getOAuthResourceIdentifier,
  resolveOAuthConfig,
} from '../../lib/oauth.ts'
import type { OAuthConfig } from '../../lib/oauth.ts'

export const oauthWellKnownPath = '/.well-known/oauth-authorization-server'
export const openidConfigurationPath = '/.well-known/openid-configuration'
export const protectedResourceMetadataPath =
  '/.well-known/oauth-protected-resource'

export const issuerBaseUrl = 'https://issuer.example.test'
export const introspectionPath = '/introspect'

// The resource identifier this server answers for in these cases, and the
// request base URL it derives from.
export const resourceBaseUrl = new URL('https://resource.example.test/')
export const resourceIdentifier = getOAuthResourceIdentifier(resourceBaseUrl)
export const otherResource = 'https://other.example.test/'
export const resourceMetadataUrl = `https://resource.example.test${protectedResourceMetadataPath}`

// In-process introspection responses keyed by token, mirroring the
// fixtures the upstream introspection endpoint would return.
export const mockIntrospectionResponses: Record<
  string,
  Record<string, unknown>
> = {
  'token-for-another-resource': {
    active: true,
    aud: otherResource,
    client_id: 'oauth-test-client',
    scope: 'packages:list',
  },
  'token-with-array-aud': {
    active: true,
    aud: [otherResource, resourceIdentifier.href],
    client_id: 'oauth-test-client',
    scope: 'packages:list',
  },
  'token-with-malformed-exp': {
    active: true,
    aud: resourceIdentifier.href,
    client_id: 'oauth-test-client',
    // A present-but-non-numeric `exp` must fail closed — silently dropping
    // it would treat the token as never-expiring.
    exp: 'not-a-number',
    scope: 'packages:list',
  },
  'token-with-nonstring-client-id': {
    active: true,
    aud: resourceIdentifier.href,
    // A non-string `client_id` is not an identity; AuthInfo falls back to
    // 'unknown' rather than stringifying whatever came back.
    client_id: 12_345,
    scope: 'packages:list',
  },
  'token-with-opaque-aud': {
    active: true,
    aud: 'socket-mcp',
    client_id: 'oauth-test-client',
    scope: 'packages:list',
  },
  // Well past its expiry, so the request-time expiry check rejects it even
  // though introspection still reports it active.
  'token-with-past-exp': {
    active: true,
    aud: resourceIdentifier.href,
    client_id: 'oauth-test-client',
    exp: 1_000_000_000,
    scope: 'packages:list',
  },
  'token-with-valid-exp': {
    active: true,
    aud: resourceIdentifier.href,
    client_id: 'oauth-test-client',
    exp: 4_102_444_800,
    scope: 'packages:list',
  },
  'token-with-wrong-scope': {
    active: true,
    aud: resourceIdentifier.href,
    client_id: 'oauth-test-client',
    scope: 'packages:write',
  },
  'token-without-aud': {
    active: true,
    client_id: 'oauth-test-client',
    scope: 'packages:list',
  },
  'token-without-exp': {
    active: true,
    aud: resourceIdentifier.href,
    client_id: 'oauth-test-client',
    scope: 'packages:list',
  },
}

// Capture status / headers / body written via writeHead + end so the
// ServerResponse-driven authenticateRequest can be asserted in-process.
export interface CapturedResponse {
  res: ServerResponse
  getStatus: () => number
  getHeaders: () => Record<string, string>
  getBody: () => string
}

export function assertOAuthError(
  captured: CapturedResponse,
  metadataUrl: string,
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
  // Every challenge carries the RFC 6750 `scope` parameter, so a client that
  // gets a 403 insufficient_scope knows which scopes to step up to.
  assert.equal(
    captured.getHeaders()['WWW-Authenticate'],
    `Bearer error="${expected.error}", error_description="${expected.errorDescription}", resource_metadata="${metadataUrl}", scope="packages:list"`,
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

export function makeMockResponse(): CapturedResponse {
  let status = 0
  let headers: Record<string, string> = {}
  let body = ''
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
  const res = {
    writeHead(
      statusCode: number,
      responseHeaders?: Record<string, string> | undefined,
    ) {
      status = statusCode
      if (responseHeaders) {
        headers = { ...responseHeaders }
      }
      return res
    },
    end(chunk?: string | undefined) {
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
  authorization?: string | undefined,
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
// without a live issuer. `declaredIssuer` defaults to the configured issuer;
// pass a different value to exercise the issuer-binding check.
export function mockDiscovery(declaredIssuer: string = issuerBaseUrl): void {
  nock(issuerBaseUrl)
    .get(oauthWellKnownPath)
    .reply(200, {
      issuer: declaredIssuer,
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
