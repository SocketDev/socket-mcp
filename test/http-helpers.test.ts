import type { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'

import { describe, expect, test } from 'vitest'

import {
  assertSafeHttpUrl,
  buildJsonApiHeaders,
  getRequestBaseUrl,
} from '../lib/http-helpers.ts'

describe('assertSafeHttpUrl', () => {
  test('accepts a normal public https URL', () => {
    expect(
      assertSafeHttpUrl('https://issuer.example.com/x', 'issuer').href,
    ).toBe('https://issuer.example.com/x')
  })

  test('rejects non-http(s) schemes', () => {
    expect(() => assertSafeHttpUrl('file:///etc/passwd', 'x')).toThrow(
      /must be http/,
    )
    expect(() => assertSafeHttpUrl('ftp://host/x', 'x')).toThrow(/must be http/)
  })

  test('rejects loopback + private + link-local hosts (SSRF)', () => {
    for (const u of [
      'http://127.0.0.1/x',
      'http://localhost/x',
      'http://169.254.169.254/latest/meta-data',
      'http://10.0.0.5/x',
      'http://192.168.1.1/x',
      'http://172.16.0.1/x',
      'http://[::1]/x',
    ]) {
      expect(() => assertSafeHttpUrl(u, 'x')).toThrow(/private\/loopback/)
    }
  })

  test('allows localhost only when allowLocalhost is set', () => {
    expect(assertSafeHttpUrl('http://localhost:8866/x', 'x', true).href).toBe(
      'http://localhost:8866/x',
    )
  })

  test('rejects a non-URL string', () => {
    expect(() => assertSafeHttpUrl('not a url', 'x')).toThrow(/not a valid URL/)
  })
})

describe('buildJsonApiHeaders', () => {
  test('always sets accept; adds the rest only when provided', () => {
    expect(buildJsonApiHeaders({})).toEqual({ accept: 'application/json' })
    expect(
      buildJsonApiHeaders({
        userAgent: 'ua/1',
        authToken: 'tok',
        extraHeaders: { 'x-extra': 'v' },
      }),
    ).toEqual({
      accept: 'application/json',
      'user-agent': 'ua/1',
      authorization: 'Bearer tok',
      'x-extra': 'v',
    })
  })
})

function makeRequest(headers: Record<string, string>): IncomingMessage {
  return { headers, socket: new Socket() } as unknown as IncomingMessage
}

describe('getRequestBaseUrl forwarded-host hardening', () => {
  test('accepts a clean host[:port] under trustProxy', () => {
    const req = makeRequest({ 'x-forwarded-host': 'proxy.example.com' })
    expect(getRequestBaseUrl(req, 3000, true).href).toBe(
      'http://proxy.example.com/',
    )
  })

  test('rejects a poisoned forwarded host (path/scheme/userinfo)', () => {
    for (const bad of ['evil.com/path', 'https://evil.com', 'user@evil.com']) {
      const req = makeRequest({
        host: 'observed.example.test:1234',
        'x-forwarded-host': bad,
      })
      // Falls back to the observed Host header, ignoring the poisoned value.
      expect(getRequestBaseUrl(req, 3000, true).href).toBe(
        'http://observed.example.test:1234/',
      )
    }
  })
})
