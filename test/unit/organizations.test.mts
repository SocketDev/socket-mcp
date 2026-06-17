import nock from 'nock'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { fetchOrganizations } from '../../lib/organizations.ts'

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
    // The Socket SDK authenticates with HTTP Basic (token as the username,
    // empty password) — base64('tok:') === 'dG9rOg=='.
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
})
