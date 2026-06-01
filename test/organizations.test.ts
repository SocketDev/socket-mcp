import nock from 'nock'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { fetchOrganizations } from '../lib/organizations.ts'

const API = 'https://api.socket.dev'

beforeEach(() => {
  nock.disableNetConnect()
})

afterEach(() => {
  nock.cleanAll()
  nock.enableNetConnect()
})

describe('fetchOrganizations', () => {
  test('GETs /v0/organizations with auth + returns the body', async () => {
    nock(API)
      .matchHeader('authorization', 'Bearer tok')
      .get('/v0/organizations')
      .reply(200, { organizations: { o1: { name: 'Acme' } } })

    const data = await fetchOrganizations({ baseUrl: API, authToken: 'tok' })
    expect(data).toEqual({ organizations: { o1: { name: 'Acme' } } })
  })

  test('strips trailing slash from baseUrl', async () => {
    const scope = nock(API).get('/v0/organizations').reply(200, {})
    await fetchOrganizations({ baseUrl: `${API}/` })
    expect(scope.isDone()).toBe(true)
  })

  test('throws with status + body on non-2xx', async () => {
    nock(API).get('/v0/organizations').reply(401, 'unauthorized')
    await expect(fetchOrganizations({ baseUrl: API })).rejects.toThrow(
      /organizations endpoint 401: unauthorized/,
    )
  })
})
