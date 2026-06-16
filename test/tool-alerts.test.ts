import nock from 'nock'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { defineAlertsTool } from '../lib/tool-alerts.ts'
import type { ToolHandlerExtra } from '../lib/tool-types.ts'

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

describe('alerts tool handler', () => {
  test('returns AUTH_REQUIRED when no token is resolvable', async () => {
    const result = await defineAlertsTool().handler(
      { org_slug: 'my-org' },
      noToken,
    )
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/Authentication is required/)
  })

  test('forwards curated filters and renders the response', async () => {
    nock(API)
      .matchHeader('authorization', 'Bearer tok')
      .get('/v0/orgs/my-org/alerts')
      .query({
        'filters.alertSeverity': 'high',
        'filters.alertStatus': 'open',
        per_page: '100',
      })
      .reply(200, { results: [{ id: 1 }] })

    const result = await defineAlertsTool().handler(
      { org_slug: 'my-org', severity: 'high', status: 'open' },
      withToken,
    )
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      results: [{ id: 1 }],
    })
  })

  test('returns an isError result on upstream failure', async () => {
    nock(API).get('/v0/orgs/my-org/alerts').query(true).reply(403, 'forbidden')
    const result = await defineAlertsTool().handler(
      { org_slug: 'my-org' },
      withToken,
    )
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/Error fetching alerts for my-org/)
  })
})
