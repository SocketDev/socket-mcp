import type { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'

import { describe, expect, test } from 'vitest'

import {
  assertSafeHttpUrl,
  buildJsonApiHeaders,
  buildSocketHeaders,
  getForwardedHeaderValue,
  getRequestBaseUrl,
  getRequestHeaderValue,
  parseJsonObject,
  writeJson,
  writeOAuthError,
} from '../../lib/http-helpers.ts'

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

function fakeResponse(): {
  res: ServerResponse
  calls: {
    statusCode?: number | undefined
    headers?: Record<string, string> | undefined
    body?: string | undefined
  }
} {
  const calls: {
    statusCode?: number | undefined
    headers?: Record<string, string> | undefined
    body?: string | undefined
  } = {}
  const res = {
    writeHead(statusCode: number, headers: Record<string, string>) {
      calls.statusCode = statusCode
      calls.headers = headers
    },
    end(body: string) {
      calls.body = body
    },
  } as unknown as ServerResponse
  return { res, calls }
}

describe('buildSocketHeaders', () => {
  test('pins NDJSON accept + content-type and omits auth when absent', () => {
    const headers = buildSocketHeaders()
    expect(headers['accept']).toBe('application/x-ndjson')
    expect(headers['content-type']).toBe('application/json')
    expect(headers['authorization']).toBeUndefined()
  })

  test('adds a bearer token when provided', () => {
    expect(buildSocketHeaders('tok')['authorization']).toBe('Bearer tok')
  })
})

describe('getRequestHeaderValue', () => {
  test('takes the first entry of an array header', () => {
    expect(getRequestHeaderValue(['a', 'b'])).toBe('a')
  })

  test('returns the string as-is and empty string for undefined', () => {
    expect(getRequestHeaderValue('solo')).toBe('solo')
    expect(getRequestHeaderValue(undefined)).toBe('')
  })
})

describe('getForwardedHeaderValue', () => {
  test('returns the first comma-separated hop, trimmed', () => {
    expect(getForwardedHeaderValue('1.2.3.4, 5.6.7.8')).toBe('1.2.3.4')
    expect(getForwardedHeaderValue(['  9.9.9.9  , x'])).toBe('9.9.9.9')
    expect(getForwardedHeaderValue(undefined)).toBe('')
  })
})

describe('getRequestBaseUrl', () => {
  test('ignores forwarded headers when trustProxy is off', () => {
    const req = makeRequest({
      host: 'observed.example.test',
      'x-forwarded-host': 'proxy.example.com',
      'x-forwarded-proto': 'https',
    })
    expect(getRequestBaseUrl(req, 3000, false).href).toBe(
      'http://observed.example.test/',
    )
  })

  test('honors x-forwarded-proto under trustProxy', () => {
    const req = makeRequest({
      host: 'proxy.example.com',
      'x-forwarded-proto': 'https',
    })
    expect(getRequestBaseUrl(req, 3000, true).href).toBe(
      'https://proxy.example.com/',
    )
  })

  test('falls back to localhost:port when no host header is present', () => {
    const req = makeRequest({})
    expect(getRequestBaseUrl(req, 4242, false).href).toBe(
      'http://localhost:4242/',
    )
  })

  test('uses https when the socket is TLS-encrypted', () => {
    const req = {
      headers: { host: 'secure.example.test' },
      socket: { encrypted: true },
    } as unknown as IncomingMessage
    expect(getRequestBaseUrl(req, 3000, false).href).toBe(
      'https://secure.example.test/',
    )
  })
})

describe('parseJsonObject', () => {
  test('parses a JSON object', () => {
    expect(parseJsonObject('{"a":1}', 'ctx')).toEqual({ a: 1 })
  })

  test('rejects arrays, primitives, and invalid JSON with context', () => {
    expect(() => parseJsonObject('[1,2]', 'alerts')).toThrow(
      /alerts returned invalid JSON/,
    )
    expect(() => parseJsonObject('42', 'orgs')).toThrow(
      /orgs returned invalid JSON/,
    )
    expect(() => parseJsonObject('not json', 'feed')).toThrow(
      /feed returned invalid JSON/,
    )
  })
})

describe('writeJson', () => {
  test('writes status, content-type, and serialized body', () => {
    const { res, calls } = fakeResponse()
    writeJson(res, 200, { ok: true }, { 'X-Extra': 'v' })
    expect(calls.statusCode).toBe(200)
    expect(calls.headers).toEqual({
      'Content-Type': 'application/json',
      'X-Extra': 'v',
    })
    expect(calls.body).toBe('{"ok":true}')
  })
})

describe('writeOAuthError', () => {
  test('emits an RFC 6750 error body + WWW-Authenticate header', () => {
    const { res, calls } = fakeResponse()
    writeOAuthError(res, 401, 'invalid_token', 'bad token')
    expect(calls.statusCode).toBe(401)
    expect(calls.headers!['WWW-Authenticate']).toBe(
      'Bearer error="invalid_token", error_description="bad token"',
    )
    expect(JSON.parse(calls.body!)).toEqual({
      error: 'invalid_token',
      error_description: 'bad token',
    })
  })

  test('includes resource_metadata when provided', () => {
    const { res, calls } = fakeResponse()
    writeOAuthError(
      res,
      401,
      'invalid_token',
      'bad',
      'https://mcp.socket.dev/.well-known/oauth-protected-resource',
    )
    expect(calls.headers!['WWW-Authenticate']).toContain(
      'resource_metadata="https://mcp.socket.dev/.well-known/oauth-protected-resource"',
    )
  })
})

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
