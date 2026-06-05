import { expect, test } from 'vitest'

import { applyClientApiKey } from '../lib/http-server.ts'
import type { AuthenticatedRequest } from '../lib/oauth.ts'

function reqWith(authorization?: string): AuthenticatedRequest {
  return {
    headers: authorization === undefined ? {} : { authorization },
  } as unknown as AuthenticatedRequest
}

test('applyClientApiKey forwards a Bearer token onto req.auth', () => {
  const req = reqWith('Bearer sk-abc')
  applyClientApiKey(req)
  expect(req.auth?.token).toBe('sk-abc')
  expect(req.auth?.clientId).toBe('socket-api-key')
})

test('applyClientApiKey is case-insensitive on the scheme', () => {
  const req = reqWith('bearer sk-xyz')
  applyClientApiKey(req)
  expect(req.auth?.token).toBe('sk-xyz')
})

test('applyClientApiKey ignores a missing Authorization header', () => {
  const req = reqWith()
  applyClientApiKey(req)
  expect(req.auth).toBeUndefined()
})

test('applyClientApiKey ignores a non-bearer scheme', () => {
  const req = reqWith('Basic dXNlcjpwYXNz')
  applyClientApiKey(req)
  expect(req.auth).toBeUndefined()
})
