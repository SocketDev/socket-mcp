import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  envBool,
  envInt,
  envString,
  getMcpHttpMode,
  getMcpPort,
  getSocketBlobCacheBytes,
  getSocketBlobUrl,
  getSocketBypassHeaderName,
  getSocketOauthRequiredScopes,
  getTrustProxy,
} from '../../lib/env.ts'

const TOUCHED = [
  'TEST_ENV_BOOL',
  'TEST_ENV_INT',
  'TEST_ENV_STRING',
  'MCP_HTTP_MODE',
  'MCP_PORT',
  'SOCKET_BLOB_CACHE_BYTES',
  'SOCKET_BLOB_URL',
  'SOCKET_BYPASS_HEADER_NAME',
  'SOCKET_OAUTH_REQUIRED_SCOPES',
  'TRUST_PROXY',
]

let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = {}
  for (let i = 0, { length } = TOUCHED; i < length; i += 1) {
    const key = TOUCHED[i]!
    saved[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (let i = 0, { length } = TOUCHED; i < length; i += 1) {
    const key = TOUCHED[i]!
    const value = saved[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

describe('envBool', () => {
  test('treats "1" and "true" (any case) as true', () => {
    process.env['TEST_ENV_BOOL'] = '1'
    expect(envBool('TEST_ENV_BOOL')).toBe(true)
    process.env['TEST_ENV_BOOL'] = 'TRUE'
    expect(envBool('TEST_ENV_BOOL')).toBe(true)
  })

  test('treats unset, empty, and other values as false', () => {
    expect(envBool('TEST_ENV_BOOL')).toBe(false)
    process.env['TEST_ENV_BOOL'] = ''
    expect(envBool('TEST_ENV_BOOL')).toBe(false)
    process.env['TEST_ENV_BOOL'] = 'no'
    expect(envBool('TEST_ENV_BOOL')).toBe(false)
  })
})

describe('envInt', () => {
  test('parses an integer', () => {
    process.env['TEST_ENV_INT'] = '42'
    expect(envInt('TEST_ENV_INT')).toBe(42)
  })

  test('returns undefined for unset or non-numeric values', () => {
    expect(envInt('TEST_ENV_INT')).toBeUndefined()
    process.env['TEST_ENV_INT'] = 'abc'
    expect(envInt('TEST_ENV_INT')).toBeUndefined()
  })
})

describe('envString', () => {
  test('returns the value or undefined for unset/empty', () => {
    expect(envString('TEST_ENV_STRING')).toBeUndefined()
    process.env['TEST_ENV_STRING'] = ''
    expect(envString('TEST_ENV_STRING')).toBeUndefined()
    process.env['TEST_ENV_STRING'] = 'hello'
    expect(envString('TEST_ENV_STRING')).toBe('hello')
  })
})

describe('getMcpHttpMode / getMcpPort / getTrustProxy', () => {
  test('http mode reflects MCP_HTTP_MODE', () => {
    expect(getMcpHttpMode()).toBe(false)
    process.env['MCP_HTTP_MODE'] = 'true'
    expect(getMcpHttpMode()).toBe(true)
  })

  test('port defaults to 3000 and reads MCP_PORT', () => {
    expect(getMcpPort()).toBe(3000)
    process.env['MCP_PORT'] = '8080'
    expect(getMcpPort()).toBe(8080)
  })

  test('trust proxy reflects TRUST_PROXY', () => {
    expect(getTrustProxy()).toBe(false)
    process.env['TRUST_PROXY'] = '1'
    expect(getTrustProxy()).toBe(true)
  })
})

describe('getSocketBlobCacheBytes', () => {
  test('defaults to 64 MB and rejects non-positive values', () => {
    expect(getSocketBlobCacheBytes()).toBe(64 * 1024 * 1024)
    process.env['SOCKET_BLOB_CACHE_BYTES'] = '0'
    expect(getSocketBlobCacheBytes()).toBe(64 * 1024 * 1024)
    process.env['SOCKET_BLOB_CACHE_BYTES'] = '2048'
    expect(getSocketBlobCacheBytes()).toBe(2048)
  })
})

describe('getSocketBlobUrl / getSocketBypassHeaderName', () => {
  test('blob url falls back to socketusercontent.com', () => {
    expect(getSocketBlobUrl()).toBe('https://socketusercontent.com')
    process.env['SOCKET_BLOB_URL'] = 'https://example.test'
    expect(getSocketBlobUrl()).toBe('https://example.test')
  })

  test('bypass header name defaults to empty string', () => {
    expect(getSocketBypassHeaderName()).toBe('')
  })
})

describe('getSocketOauthRequiredScopes', () => {
  test('returns an empty array when unset', () => {
    expect(getSocketOauthRequiredScopes()).toEqual([])
  })

  test('splits on whitespace and commas, dropping blanks', () => {
    process.env['SOCKET_OAUTH_REQUIRED_SCOPES'] = 'a, b  c,,d'
    expect(getSocketOauthRequiredScopes()).toEqual(['a', 'b', 'c', 'd'])
  })
})
