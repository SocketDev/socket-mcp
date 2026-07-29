import nock from 'nock'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { defineThreatFeedTool } from '../../lib/tool-threat-feed.ts'
import type { ToolHandlerExtra } from '../../lib/tool-types.ts'

const API = 'https://api.socket.dev'

const withToken: ToolHandlerExtra = { authInfo: { token: 'tok' } }
const noToken: ToolHandlerExtra = {}

beforeEach(() => {
  nock.disableNetConnect()
})

afterEach(() => {
  nock.cleanAll()
  nock.enableNetConnect()
})

describe('threat_feed tool handler', () => {
  test('returns AUTH_REQUIRED when no token is resolvable', async () => {
    const result = await defineThreatFeedTool().handler(
      { org_slug: 'my-org' },
      noToken,
    )
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/Authentication is required/)
  })

  test('forwards filters and renders the response', async () => {
    nock(API)
      .matchHeader('authorization', 'Bearer tok')
      .get('/v0/orgs/my-org/threat-feed')
      .query({ filter: 'mal', ecosystem: 'npm' })
      .reply(200, { results: [{ id: 'a' }], nextPageCursor: 'c2' })

    const result = await defineThreatFeedTool().handler(
      { org_slug: 'my-org', filter: 'mal', ecosystem: 'npm' },
      withToken,
    )
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      results: [{ id: 'a' }],
      nextPageCursor: 'c2',
    })
  })

  test('forwards every optional filter and the pagination cursor', async () => {
    nock(API)
      .get('/v0/orgs/my-org/threat-feed')
      .query({
        created_after: '2026-02-01T00:00:00Z',
        direction: 'asc',
        ecosystem: 'pypi',
        filter: 'typ',
        is_human_reviewed: 'true',
        name: 'reqeusts',
        page_cursor: 'cursor-2',
        per_page: '50',
        sort: 'created_at',
        updated_after: '2026-01-01T00:00:00Z',
        version: '1.0.0',
      })
      .reply(200, { results: [], nextPageCursor: undefined })

    // The interceptor's query matcher is the assertion: it only matches when
    // every snake_case tool argument reaches its curated query parameter.
    const result = await defineThreatFeedTool().handler(
      {
        org_slug: 'my-org',
        created_after: '2026-02-01T00:00:00Z',
        cursor: 'cursor-2',
        direction: 'asc',
        ecosystem: 'pypi',
        filter: 'typ',
        is_human_reviewed: true,
        name: 'reqeusts',
        per_page: 50,
        sort: 'created_at',
        updated_after: '2026-01-01T00:00:00Z',
        version: '1.0.0',
      },
      withToken,
    )
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.content[0]!.text)).toEqual({ results: [] })
  })

  test('returns an isError result on upstream failure', async () => {
    nock(API).get('/v0/orgs/my-org/threat-feed').query(true).reply(500, 'boom')
    const result = await defineThreatFeedTool().handler(
      { org_slug: 'my-org' },
      withToken,
    )
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(
      /Error fetching threat feed for my-org/,
    )
  })
})
