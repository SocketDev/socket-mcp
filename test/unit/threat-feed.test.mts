import nock from 'nock'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { buildThreatFeedQuery, fetchThreatFeed } from '../../lib/threat-feed.ts'

const API = 'https://api.socket.dev'

beforeEach(() => {
  nock.disableNetConnect()
})

afterEach(() => {
  nock.cleanAll()
  nock.enableNetConnect()
})

describe('buildThreatFeedQuery', () => {
  test('maps curated filters to API query params', () => {
    const qs = buildThreatFeedQuery({
      perPage: 30,
      cursor: 'c1',
      sort: 'created_at',
      direction: 'asc',
      updatedAfter: '2026-01-01T00:00:00Z',
      createdAfter: '2026-02-01T00:00:00Z',
      filter: 'mal',
      name: 'lodash',
      version: '1.0.0',
      isHumanReviewed: true,
      ecosystem: 'npm',
    })
    expect(qs.get('per_page')).toBe('30')
    expect(qs.get('page_cursor')).toBe('c1')
    expect(qs.get('sort')).toBe('created_at')
    expect(qs.get('direction')).toBe('asc')
    expect(qs.get('updated_after')).toBe('2026-01-01T00:00:00Z')
    expect(qs.get('created_after')).toBe('2026-02-01T00:00:00Z')
    expect(qs.get('filter')).toBe('mal')
    expect(qs.get('name')).toBe('lodash')
    expect(qs.get('version')).toBe('1.0.0')
    expect(qs.get('is_human_reviewed')).toBe('true')
    expect(qs.get('ecosystem')).toBe('npm')
  })

  test('skips undefined keys', () => {
    const qs = buildThreatFeedQuery(undefined)
    expect(qs.toString()).toBe('')
  })
})

describe('fetchThreatFeed', () => {
  test('builds the org-scoped URL with auth + returns the body', async () => {
    nock(API)
      .matchHeader('authorization', 'Bearer tok')
      .get('/v0/orgs/my-org/threat-feed')
      .query({ filter: 'mal', per_page: '30' })
      .reply(200, { results: [{ id: 'abc' }] })

    const data = await fetchThreatFeed({
      baseUrl: API,
      orgSlug: 'my-org',
      authToken: 'tok',
      filters: { filter: 'mal', perPage: 30 },
    })
    expect(data).toEqual({ results: [{ id: 'abc' }] })
  })

  test('throws with status + body on non-2xx', async () => {
    nock(API).get('/v0/orgs/my-org/threat-feed').reply(500, 'boom')
    await expect(
      fetchThreatFeed({ baseUrl: API, orgSlug: 'my-org' }),
    ).rejects.toThrow(/threat-feed endpoint 500: boom/)
  })
})
