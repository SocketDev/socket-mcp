import { expect, test } from 'vitest'

import { tokenIdentity } from '../../../lib/tool-audit.mts'

test('uses operator identity without a bearer token', () => {
  expect(tokenIdentity(undefined)).toBe('operator')
  expect(tokenIdentity('')).toBe('operator')
})

test('produces stable distinct pseudonymous token identities', () => {
  const identity = tokenIdentity('test_fake_token')
  expect(identity).toMatch(/^sha256:[a-f0-9]{16}$/u)
  expect(tokenIdentity('test_fake_token')).toBe(identity)
  expect(tokenIdentity('test_fake_other_token')).not.toBe(identity)
})
