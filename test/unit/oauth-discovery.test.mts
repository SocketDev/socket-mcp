import nock from 'nock'
import { afterEach, beforeEach, expect, test } from 'vitest'

import {
  buildOAuthWellKnownUrls,
  loadOAuthMetadata,
  validateOAuthMetadataFields,
} from '../../lib/oauth-discovery.ts'
import {
  introspectionPath,
  issuerBaseUrl,
  makeConfig,
  mockDiscovery,
  oauthWellKnownPath,
  openidConfigurationPath,
} from './oauth-fixtures.mts'

beforeEach(() => {
  nock.disableNetConnect()
})

afterEach(() => {
  nock.cleanAll()
  nock.enableNetConnect()
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

test('validateOAuthMetadataFields names introspection_endpoint as our own constraint', () => {
  expect(() =>
    validateOAuthMetadataFields({
      issuer: issuerBaseUrl,
      authorization_endpoint: `${issuerBaseUrl}/authorize`,
      token_endpoint: `${issuerBaseUrl}/token`,
    }),
  ).toThrow(
    /missing required field: introspection_endpoint — RFC 8414 leaves it optional, but socket-mcp requires it/,
  )
})

test('buildOAuthWellKnownUrls keeps a path-bearing issuer tenant', () => {
  // Regression: `new URL('/.well-known/...', issuer)` dropped `/tenant1` and
  // discovered the root tenant's metadata instead.
  expect(
    buildOAuthWellKnownUrls(new URL('https://auth.example.com/tenant1')),
  ).toEqual([
    'https://auth.example.com/.well-known/oauth-authorization-server/tenant1',
    'https://auth.example.com/.well-known/openid-configuration/tenant1',
    'https://auth.example.com/tenant1/.well-known/openid-configuration',
  ])
})

test('buildOAuthWellKnownUrls uses the two root forms for a path-less issuer', () => {
  expect(buildOAuthWellKnownUrls(new URL('https://auth.example.com'))).toEqual([
    'https://auth.example.com/.well-known/oauth-authorization-server',
    'https://auth.example.com/.well-known/openid-configuration',
  ])
  // A bare trailing slash is not a path component.
  expect(buildOAuthWellKnownUrls(new URL('https://auth.example.com/'))).toEqual(
    [
      'https://auth.example.com/.well-known/oauth-authorization-server',
      'https://auth.example.com/.well-known/openid-configuration',
    ],
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

test('loadOAuthMetadata reports every probed URL when none yields metadata', async () => {
  nock(issuerBaseUrl).get(oauthWellKnownPath).reply(500, 'boom')
  const config = makeConfig()
  await expect(loadOAuthMetadata(config)).rejects.toThrow(
    /discovery found no usable metadata for issuer "https:\/\/issuer\.example\.test"/,
  )
  // Cache was cleared, so a retry re-requests — succeed this time.
  mockDiscovery()
  const metadata = await loadOAuthMetadata(config)
  expect(metadata?.issuer).toBe(issuerBaseUrl)
})

test('a failing probe leaves a newer in-flight discovery cached', async () => {
  nock(issuerBaseUrl).get(oauthWellKnownPath).reply(500, 'boom')
  nock(issuerBaseUrl).get(openidConfigurationPath).reply(500, 'boom')
  const config = makeConfig()
  const failing = loadOAuthMetadata(config)
  // Stand a fresh discovery up while the first is still in flight; the
  // first one's failure must not evict the newer cache entry.
  config.metadataPromise = undefined
  mockDiscovery()
  const retry = loadOAuthMetadata(config)
  const { metadataPromise: cachedAfterRetry } = config

  await expect(failing).rejects.toThrow(/discovery found no usable metadata/)
  expect((await retry)?.issuer).toBe(issuerBaseUrl)
  expect(config.metadataPromise).toBe(cachedAfterRetry)
})

test('loadOAuthMetadata rejects a document whose issuer differs, naming both', async () => {
  mockDiscovery('https://evil.example.test')
  // The path-less issuer has a second probe URL; leave it 404ing so the
  // aggregate error is what surfaces.
  nock(issuerBaseUrl).get(openidConfigurationPath).reply(404, 'nope')
  await expect(loadOAuthMetadata(makeConfig())).rejects.toThrow(
    /issuer mismatch: document declares "https:\/\/evil\.example\.test", SOCKET_OAUTH_ISSUER is "https:\/\/issuer\.example\.test"/,
  )
})

test('loadOAuthMetadata compares the issuer byte for byte', async () => {
  // RFC 3986 simple string comparison: a trailing slash is a difference.
  mockDiscovery(`${issuerBaseUrl}/`)
  nock(issuerBaseUrl).get(openidConfigurationPath).reply(404, 'nope')
  await expect(loadOAuthMetadata(makeConfig())).rejects.toThrow(
    /issuer mismatch/,
  )
})

test('loadOAuthMetadata falls back to the OIDC well-known URL', async () => {
  nock(issuerBaseUrl).get(oauthWellKnownPath).reply(404, 'nope')
  nock(issuerBaseUrl)
    .get(openidConfigurationPath)
    .reply(200, {
      issuer: issuerBaseUrl,
      authorization_endpoint: `${issuerBaseUrl}/authorize`,
      token_endpoint: `${issuerBaseUrl}/token`,
      introspection_endpoint: `${issuerBaseUrl}${introspectionPath}`,
    })
  const metadata = await loadOAuthMetadata(makeConfig())
  expect(metadata?.issuer).toBe(issuerBaseUrl)
})

test('loadOAuthMetadata probes a path-bearing issuer at the path-inserted URL', async () => {
  const tenantIssuer = `${issuerBaseUrl}/tenant1`
  nock(issuerBaseUrl)
    .get(`${oauthWellKnownPath}/tenant1`)
    .reply(200, {
      issuer: tenantIssuer,
      authorization_endpoint: `${tenantIssuer}/authorize`,
      token_endpoint: `${tenantIssuer}/token`,
      introspection_endpoint: `${tenantIssuer}${introspectionPath}`,
    })
  const metadata = await loadOAuthMetadata(makeConfig({ issuer: tenantIssuer }))
  expect(metadata?.issuer).toBe(tenantIssuer)
})
