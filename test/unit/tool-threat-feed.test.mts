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
