import { describe, expect, test } from 'vitest'

import { tokenIdentity } from '../../../lib/tool-audit.mts'
import { resolveToolAuditIdentity } from '../../../lib/server.mts'

describe('tool audit transport identity', () => {
  test('uses operator identity for explicitly declared stdio', () => {
    expect(resolveToolAuditIdentity('stdio', 'test_fake_token')).toEqual({
      kind: 'operator',
    })
  })

  test('uses anonymous identity without HTTP bearer credentials', () => {
    expect(resolveToolAuditIdentity('http', undefined)).toEqual({
      kind: 'anonymous',
    })
    expect(resolveToolAuditIdentity('anonymous', 'test_fake_token')).toEqual({
      kind: 'anonymous',
    })
  })

  test('pseudonymizes the actual HTTP bearer credential', () => {
    const token = 'test_fake_http_bearer_token'
    const identity = resolveToolAuditIdentity('http', token)
    expect(identity).toEqual({
      kind: 'bearer',
      tokenHash: tokenIdentity(token),
    })
    expect(JSON.stringify(identity)).not.toContain(token)
  })
})
