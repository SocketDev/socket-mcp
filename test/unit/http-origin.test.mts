import type { IncomingMessage, ServerResponse } from 'node:http'

import { describe, expect, test } from 'vitest'

import {
  isLocalhostOrigin,
  patchAcceptHeader,
  validateOriginAndHost,
  writeCorsHeaders,
} from '../../lib/http-origin.ts'

describe('isLocalhostOrigin', () => {
  test('accepts localhost and 127.0.0.1 on any port', () => {
    expect(isLocalhostOrigin('http://localhost:3000')).toBe(true)
    expect(isLocalhostOrigin('http://127.0.0.1:8080')).toBe(true)
    expect(isLocalhostOrigin('https://localhost')).toBe(true)
  })

  test('rejects non-localhost hosts', () => {
    expect(isLocalhostOrigin('https://mcp.socket.dev')).toBe(false)
    expect(isLocalhostOrigin('https://evil.example.com')).toBe(false)
  })

  test('returns false for an unparseable URL', () => {
    expect(isLocalhostOrigin('not a url')).toBe(false)
    expect(isLocalhostOrigin('')).toBe(false)
  })
})

describe('validateOriginAndHost', () => {
  test('allows a localhost origin regardless of host', () => {
    expect(
      validateOriginAndHost('http://localhost:3000', 'anything', 3000),
    ).toBe(true)
  })

  test('allows a production allow-listed origin', () => {
    expect(
      validateOriginAndHost('https://mcp.socket.dev', 'ignored', 3000),
    ).toBe(true)
    expect(
      validateOriginAndHost('https://mcp.socket-staging.dev', 'ignored', 3000),
    ).toBe(true)
  })

  test('rejects a non-allow-listed origin', () => {
    expect(
      validateOriginAndHost('https://evil.example.com', 'localhost:3000', 3000),
    ).toBe(false)
  })

  test('falls back to host check when no origin is sent', () => {
    expect(validateOriginAndHost('', 'localhost:3000', 3000)).toBe(true)
    expect(validateOriginAndHost('', '127.0.0.1:3000', 3000)).toBe(true)
    expect(validateOriginAndHost('', 'localhost', 3000)).toBe(true)
    expect(validateOriginAndHost('', 'mcp.socket.dev', 3000)).toBe(true)
    expect(validateOriginAndHost('', 'evil.example.com', 3000)).toBe(false)
  })
})

describe('patchAcceptHeader', () => {
  function fakeReq(accept: string | undefined): IncomingMessage {
    const rawHeaders = accept === undefined ? [] : ['Accept', accept]
    return {
      headers: accept === undefined ? {} : { accept },
      rawHeaders,
    } as unknown as IncomingMessage
  }

  test('leaves a complete Accept header untouched', () => {
    const req = fakeReq('application/json, text/event-stream')
    patchAcceptHeader(req)
    expect(req.headers.accept).toBe('application/json, text/event-stream')
  })

  test('rewrites an incomplete Accept header and patches rawHeaders', () => {
    const req = fakeReq('application/json')
    patchAcceptHeader(req)
    expect(req.headers.accept).toBe('application/json, text/event-stream')
    const idx = req.rawHeaders.findIndex(h => h.toLowerCase() === 'accept')
    expect(req.rawHeaders[idx + 1]).toBe('application/json, text/event-stream')
  })

  test('appends Accept to rawHeaders when absent', () => {
    const req = fakeReq(undefined)
    patchAcceptHeader(req)
    expect(req.headers.accept).toBe('application/json, text/event-stream')
    expect(req.rawHeaders).toContain('Accept')
  })
})

describe('writeCorsHeaders', () => {
  function fakeRes(): {
    res: ServerResponse
    headers: Record<string, string>
  } {
    const headers: Record<string, string> = {}
    const res = {
      setHeader(name: string, value: string) {
        headers[name] = value
      },
    } as unknown as ServerResponse
    return { res, headers }
  }

  test('sets CORS headers when an origin is present', () => {
    const { res, headers } = fakeRes()
    writeCorsHeaders(res, 'https://mcp.socket.dev')
    expect(headers['Access-Control-Allow-Origin']).toBe(
      'https://mcp.socket.dev',
    )
    expect(headers['Access-Control-Allow-Methods']).toContain('POST')
    expect(headers['Access-Control-Expose-Headers']).toContain('Mcp-Session-Id')
  })

  test('writes nothing when origin is empty', () => {
    const { res, headers } = fakeRes()
    writeCorsHeaders(res, '')
    expect(Object.keys(headers)).toHaveLength(0)
  })
})
