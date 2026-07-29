/**
 * @file The version the server reports. `resolvePackageVersion` takes an
 *   already-parsed manifest, so the fallback is reachable without mocking
 *   `fs` at module-init time.
 */

import { describe, expect, test } from 'vitest'

import { resolvePackageVersion, VERSION } from '../../lib/version.ts'

describe('resolvePackageVersion', () => {
  test('reads the version out of the manifest', () => {
    expect(resolvePackageVersion({ version: '1.2.3' })).toBe('1.2.3')
  })

  test('falls back for a manifest with no version', () => {
    expect(resolvePackageVersion({})).toBe('0.0.1')
  })

  test('falls back for an empty version', () => {
    expect(resolvePackageVersion({ version: '' })).toBe('0.0.1')
  })

  test('falls back for a non-string version', () => {
    expect(resolvePackageVersion({ version: 5 })).toBe('0.0.1')
  })
})

describe('VERSION', () => {
  test('is the version this package ships', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/u)
  })
})
