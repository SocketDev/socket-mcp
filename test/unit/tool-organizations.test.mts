import nock from 'nock'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { defineOrganizationsTool } from '../../lib/tool-organizations.ts'
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

describe('organizations tool handler', () => {
  test('returns AUTH_REQUIRED when no token is resolvable', async () => {
    const result = await defineOrganizationsTool().handler({}, noToken)
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/Authentication is required/)
  })

  test('renders the fetched organizations as pretty JSON', async () => {
    nock(API)
      .get('/v0/organizations')
      .reply(200, { organizations: { o1: { name: 'Acme' } } })

    const result = await defineOrganizationsTool().handler({}, withToken)
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      organizations: { o1: { name: 'Acme' } },
    })
  })

  test('returns an isError result on upstream failure', async () => {
    nock(API).get('/v0/organizations').reply(401, { error: 'unauthorized' })
    const result = await defineOrganizationsTool().handler({}, withToken)
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/Error fetching organizations/)
  })
})
