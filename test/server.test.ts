import { afterEach, expect, test } from 'vitest'

import {
  resolveAuthToken,
  resolveScopedAuthToken,
  setStaticApiKey,
} from '../lib/server.ts'

afterEach(() => {
  // Reset module-level static-key state so cases don't leak into each other.
  setStaticApiKey('')
})

test('resolveAuthToken prefers the per-request token', () => {
  setStaticApiKey('static-key', { shared: true })
  expect(resolveAuthToken('req-token')).toBe('req-token')
})

test('resolveAuthToken falls back to the static key for public data', () => {
  setStaticApiKey('static-key', { shared: true })
  expect(resolveAuthToken(undefined)).toBe('static-key')
})

test('resolveAuthToken returns undefined when nothing is set', () => {
  expect(resolveAuthToken(undefined)).toBeUndefined()
})

test('resolveScopedAuthToken prefers the per-request token', () => {
  setStaticApiKey('operator-key', { shared: true })
  expect(resolveScopedAuthToken('caller-token')).toBe('caller-token')
})

test('resolveScopedAuthToken uses the static key in stdio mode (user-owned)', () => {
  setStaticApiKey('user-key', { shared: false })
  expect(resolveScopedAuthToken(undefined)).toBe('user-key')
})

test('resolveScopedAuthToken refuses a shared deploy key in HTTP mode', () => {
  setStaticApiKey('operator-key', { shared: true })
  expect(resolveScopedAuthToken(undefined)).toBeUndefined()
})

test('setStaticApiKey defaults shared to false', () => {
  setStaticApiKey('user-key')
  expect(resolveScopedAuthToken(undefined)).toBe('user-key')
})
