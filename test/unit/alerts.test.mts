import nock from 'nock'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { buildAlertsQuery, fetchAlerts } from '../../lib/alerts.ts'

const API = 'https://api.socket.dev'

beforeEach(() => {
  nock.disableNetConnect()
})

afterEach(() => {
  nock.cleanAll()
  nock.enableNetConnect()
})

describe('buildAlertsQuery', () => {
  test('maps curated filters to flat filters.* params', () => {
    const qs = buildAlertsQuery({
      severity: 'high,critical',
      status: 'open',
      category: 'vulnerability',
      artifactType: 'npm',
      artifactName: 'lodash',
      alertType: 'usesEval',
      repoSlug: 'my-repo',
      perPage: 50,
      cursor: 'abc',
    })
    expect(qs.get('filters.alertSeverity')).toBe('high,critical')
    expect(qs.get('filters.alertStatus')).toBe('open')
    expect(qs.get('filters.alertCategory')).toBe('vulnerability')
    expect(qs.get('filters.artifactType')).toBe('npm')
    expect(qs.get('filters.artifactName')).toBe('lodash')
    expect(qs.get('filters.alertType')).toBe('usesEval')
    expect(qs.get('filters.repoSlug')).toBe('my-repo')
    expect(qs.get('per_page')).toBe('50')
    expect(qs.get('startAfterCursor')).toBe('abc')
  })

  test('skips undefined keys and applies perPage fallback', () => {
    const qs = buildAlertsQuery(undefined, 100)
    expect(qs.get('per_page')).toBe('100')
    expect(qs.get('filters.alertSeverity')).toBe(null)
  })
})

describe('fetchAlerts', () => {
  test('builds the org-scoped URL with auth + returns the body', async () => {
    nock(API)
      .matchHeader('authorization', 'Bearer tok')
      .get('/v0/orgs/my-org/alerts')
      .query({ 'filters.alertSeverity': 'high', per_page: '100' })
      .reply(200, { results: [{ id: 1 }] })

    const data = await fetchAlerts({
      baseUrl: API,
      orgSlug: 'my-org',
      authToken: 'tok',
      filters: { severity: 'high', perPage: 100 },
    })
    expect(data).toEqual({ results: [{ id: 1 }] })
  })

  test('throws with status + body on non-2xx', async () => {
    nock(API).get('/v0/orgs/my-org/alerts').reply(403, 'forbidden')
    await expect(
      fetchAlerts({ baseUrl: API, orgSlug: 'my-org' }),
    ).rejects.toThrow(/alerts endpoint 403: forbidden/)
  })
})
