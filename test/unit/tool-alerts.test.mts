import nock from 'nock'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { defineAlertsTool } from '../../lib/tool-alerts.ts'
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

  test('forwards every optional filter and the pagination cursor', async () => {
    nock(API)
      .get('/v0/orgs/my-org/alerts')
      .query({
        'filters.alertCategory': 'supplyChainRisk',
        'filters.alertSeverity': 'critical',
        'filters.alertStatus': 'triaged',
        'filters.artifactName': 'left-pad',
        'filters.alertType': 'malware',
        'filters.artifactType': 'npm',
        'filters.repoSlug': 'web',
        per_page: '25',
        startAfterCursor: 'cursor-2',
      })
      .reply(200, { results: [], nextPage: undefined })

    // The interceptor's query matcher is the assertion: it only matches when
    // every snake_case tool argument reaches its curated query parameter.
    const result = await defineAlertsTool().handler(
      {
        org_slug: 'my-org',
        alert_type: 'malware',
        artifact_name: 'left-pad',
        artifact_type: 'npm',
        category: 'supplyChainRisk',
        cursor: 'cursor-2',
        per_page: 25,
        repo_slug: 'web',
        severity: 'critical',
        status: 'triaged',
      },
      withToken,
    )
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.content[0]!.text)).toEqual({ results: [] })
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
