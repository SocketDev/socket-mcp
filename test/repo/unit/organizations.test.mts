import nock from 'nock'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { fetchOrganizations } from '../../../lib/organizations.mts'

const API = 'https://api.socket.dev'

beforeEach(() => {
  nock.disableNetConnect()
})

afterEach(() => {
  nock.cleanAll()
  nock.enableNetConnect()
})

describe('fetchOrganizations', () => {
  test('GETs /v0/organizations with Basic auth + returns the body', async () => {
    // HTTP Basic uses the token as the username and an empty password.
    nock(API)
      .matchHeader('authorization', 'Basic dG9rOg==')
      .get('/v0/organizations')
      .reply(200, { organizations: { o1: { name: 'Acme' } } })

    const data = await fetchOrganizations({ baseUrl: API, authToken: 'tok' })
    expect(data).toEqual({ organizations: { o1: { name: 'Acme' } } })
  })

  test('strips trailing slash from baseUrl', async () => {
    const scope = nock(API).get('/v0/organizations').reply(200, {})
    await fetchOrganizations({ baseUrl: `${API}/`, authToken: 'tok' })
    expect(scope.isDone()).toBe(true)
  })

  test('throws with status + body on non-2xx', async () => {
    nock(API).get('/v0/organizations').reply(401, { error: 'unauthorized' })
    await expect(
      fetchOrganizations({ baseUrl: API, authToken: 'tok' }),
    ).rejects.toThrow(/organizations endpoint 401/)
  })

  test('retries a transient response and respects Retry-After', async () => {
    const scope = nock(API)
      .get('/v0/organizations')
      .reply(429, { error: 'rate limited' }, { 'retry-after': '0' })
      .get('/v0/organizations')
      .reply(200, { organizations: {} })
    await expect(
      fetchOrganizations({ baseUrl: API, authToken: 'tok' }),
    ).resolves.toEqual({ organizations: {} })
    expect(scope.isDone()).toBe(true)
  })

  test('does not retry a non-rate-limit client error', async () => {
    const scope = nock(API).get('/v0/organizations').reply(403, 'forbidden')
    await expect(
      fetchOrganizations({ baseUrl: API, authToken: 'tok' }),
    ).rejects.toThrow('organizations endpoint 403: forbidden')
    expect(scope.isDone()).toBe(true)
  })

  test('treats an empty successful body as an empty object', async () => {
    nock(API).get('/v0/organizations').reply(200)
    await expect(
      fetchOrganizations({ baseUrl: API, authToken: 'tok' }),
    ).resolves.toEqual({})
  })

  test('limits the response body to 10 MiB', async () => {
    nock(API)
      .get('/v0/organizations')
      .times(4)
      .reply(200, 'x'.repeat(10 * 1024 * 1024 + 1))
    await expect(
      fetchOrganizations({ baseUrl: API, authToken: 'tok' }),
    ).rejects.toThrow(/maxResponseSize|response size|exceeds/iu)
  })
})

describe('fetchOrganizations auth and error shape', () => {
  test('refuses to send a request with no token', async () => {
    await expect(fetchOrganizations({ baseUrl: API })).rejects.toThrow(
      'Socket API token is required for organizations',
    )
    expect(nock.pendingMocks()).toEqual([])
  })
})
