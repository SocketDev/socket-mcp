import type { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import nock from 'nock'
import { afterEach, beforeEach, expect, onTestFinished, test } from 'vitest'

import {
  authenticateRequest,
  buildProtectedResourceMetadata,
  getProtectedResourceMetadataUrl,
  loadOAuthMetadata,
  resolveOAuthConfig,
  splitScopes,
  validateOAuthMetadataFields,
  verifyAccessToken,
} from '../lib/oauth.ts'
import type { OAuthConfig } from '../lib/oauth.ts'
import { getRequestBaseUrl } from '../lib/http-helpers.ts'

const serverPath = path.join(import.meta.dirname, '..', 'index.ts')
const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => value !== undefined),
) as Record<string, string>

const oauthWellKnownPath = '/.well-known/oauth-authorization-server'
const protectedResourceMetadataPath = '/.well-known/oauth-protected-resource'

const issuerBaseUrl = 'https://issuer.example.test'
const introspectionPath = '/introspect'

// In-process introspection responses keyed by token, mirroring the
// fixtures the upstream introspection endpoint would return.
const mockIntrospectionResponses: Record<string, Record<string, unknown>> = {
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
  const body = JSON.parse(captured.getBody()) as {
    error?: string | undefined
    error_description?: string | undefined
  }
  expect(captured.getStatus()).toBe(expected.status)
  expect(body.error).toBe(expected.error)
  expect(body.error_description).toBe(expected.errorDescription)
  expect(captured.getHeaders()['WWW-Authenticate']).toBe(
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
// token the same way the old local mock-issuer server did.
export function mockIntrospection(): void {
  nock(issuerBaseUrl)
    .post(introspectionPath)
    .reply((_uri, requestBody) => {
      const token = new URLSearchParams(String(requestBody)).get('token')
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
  const body = JSON.parse(captured.getBody()) as { error?: string | undefined }
  expect(body.error).toBe('server_error')
})

// Both env-var names are valid entry points — the canonical name is
// SOCKET_API_TOKEN, but SOCKET_API_KEY is the legacy alias more tools
// (and most local-dev setups) export, so mcp's local getSocketApiToken
// shim walks the fleet-canonical chain. Cover both so a future drop of
// either alias surfaces here, not in a user report.
// socket-api-token-env: bootstrap -- this array tests the alias-normalization shim.
const SOCKET_API_TOKEN_ALIASES = [
  'SOCKET_API_TOKEN',
  'SOCKET_API_KEY',
  'SOCKET_CLI_API_TOKEN',
  'SOCKET_CLI_API_KEY',
  'SOCKET_SECURITY_API_TOKEN',
  'SOCKET_SECURITY_API_KEY',
] as const
// socket-api-token-env: bootstrap -- parametrizing tests over both aliases.
for (const tokenEnvVar of ['SOCKET_API_TOKEN', 'SOCKET_API_KEY']) {
  test(`stdio mode ignores partial OAuth config (${tokenEnvVar})`, async () => {
    // stdio transport speaks over the child's stdin/stdout — no network
    // — so this spawned-server check coexists with nock.disableNetConnect.
    // Strip every alias so we're exercising exactly the env-var name
    // this case is parametrizing on — otherwise an inherited
    // SOCKET_API_KEY on the dev machine would mask the
    // SOCKET_API_TOKEN-only path.
    const cleanEnv = { ...inheritedEnv }
    for (let i = 0, { length } = SOCKET_API_TOKEN_ALIASES; i < length; i += 1) {
      delete cleanEnv[SOCKET_API_TOKEN_ALIASES[i]!]
    }
    const transport = new StdioClientTransport({
      command: 'node',
      args: [serverPath],
      env: {
        ...cleanEnv,
        [tokenEnvVar]: 'test-api-token',
        SOCKET_OAUTH_ISSUER: 'https://issuer.example.test',
      },
    })

    const client = new Client(
      { name: 'oauth-stdio-test-client', version: '1.0.0' },
      { capabilities: {} },
    )

    onTestFinished(async () => {
      await client.close().catch(() => {})
    })

    await client.connect(transport)
    const tools = await client.listTools()
    expect(tools.tools.some(tool => tool.name === 'depscore')).toBe(true)
  })
}
