import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'

import { describe, expect, test } from 'vitest'

import {
  applyClientApiKey,
  applySocketApiKey,
  destroySession,
  handleDelete,
  handleGet,
  PayloadTooLargeError,
  readPostBody,
  reapIdleSessions,
  routeRequest,
} from '../../lib/http-server.ts'
import type { Session } from '../../lib/http-server.ts'
import type { AuthenticatedRequest } from '../../lib/oauth.ts'

function reqWith(authorization?: string): AuthenticatedRequest {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
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

test('applySocketApiKey matches a sktsec_-prefixed Bearer token', () => {
  const req = reqWith('Bearer sktsec_t_example')
  expect(applySocketApiKey(req)).toBe(true)
  expect(req.auth?.token).toBe('sktsec_t_example')
  expect(req.auth?.clientId).toBe('socket-api-key')
})

test('applySocketApiKey ignores a non-prefixed Bearer token (OAuth)', () => {
  const req = reqWith('Bearer oauth-access-token')
  expect(applySocketApiKey(req)).toBe(false)
  expect(req.auth).toBeUndefined()
})

test('applySocketApiKey returns false when no Authorization header', () => {
  const req = reqWith()
  expect(applySocketApiKey(req)).toBe(false)
  expect(req.auth).toBeUndefined()
})

// A Readable stream doubles as a stand-in for IncomingMessage here:
// readPostBody only async-iterates the request and calls `.destroy()`,
// both of which Readable provides.
function mockReq(chunks: Array<string | Buffer>): IncomingMessage {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
  return Readable.from(chunks) as unknown as IncomingMessage
}

const MAX = 4 * 1024 * 1024

describe('readPostBody', () => {
  test('returns the buffered body for a small payload', async () => {
    const body = await readPostBody(mockReq(['{"jsonrpc":', '"2.0"}']))
    expect(body).toBe('{"jsonrpc":"2.0"}')
  })

  test('concatenates Buffer chunks as UTF-8', async () => {
    const body = await readPostBody(mockReq([Buffer.from('café')]))
    expect(body).toBe('café')
  })

  test('throws PayloadTooLargeError when the body exceeds the cap', async () => {
    // One chunk just over the 4 MB limit.
    const huge = 'a'.repeat(MAX + 1)
    await expect(readPostBody(mockReq([huge]))).rejects.toBeInstanceOf(
      PayloadTooLargeError,
    )
  })

  test('counts bytes across chunks, not just the final chunk', async () => {
    // Each chunk is under the cap, but together they exceed it.
    const half = 'a'.repeat(MAX / 2 + 1)
    await expect(readPostBody(mockReq([half, half]))).rejects.toBeInstanceOf(
      PayloadTooLargeError,
    )
  })

  test('measures byte length, not char count, for multibyte payloads', async () => {
    // '€' is 3 UTF-8 bytes; MAX/2 + 1 of them exceeds MAX in bytes while
    // staying well under MAX in characters.
    const multibyte = '€'.repeat(Math.floor(MAX / 3) + 1)
    await expect(readPostBody(mockReq([multibyte]))).rejects.toBeInstanceOf(
      PayloadTooLargeError,
    )
  })

  test('a body exactly at the cap is accepted', async () => {
    const atLimit = 'a'.repeat(MAX)
    const body = await readPostBody(mockReq([atLimit]))
    expect(body.length).toBe(MAX)
  })
})

interface CapturedRes {
  statusCode?: number | undefined
  body?: string | undefined
  headers: Record<string, string>
}

function makeRes(): { res: ServerResponse; captured: CapturedRes } {
  const captured: CapturedRes = { headers: {} }
  let sent = false
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
  const res = {
    get headersSent() {
      return sent
    },
    setHeader(name: string, value: string) {
      captured.headers[name] = value
    },
    writeHead(code: number) {
      captured.statusCode = code
      sent = true
      return res
    },
    end(chunk?: string) {
      if (chunk !== undefined) {
        captured.body = chunk
      }
      sent = true
    },
    write() {
      return true
    },
  } as unknown as ServerResponse
  return { res, captured }
}

function plainReq(opts: {
  url: string
  method: string
  headers?: Record<string, string> | undefined
}): IncomingMessage {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
  return {
    url: opts.url,
    method: opts.method,
    headers: opts.headers ?? {},
    rawHeaders: [],
    socket: {},
  } as unknown as IncomingMessage
}

function postReq(
  body: string,
  headers?: Record<string, string>,
): IncomingMessage {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
  const req = Readable.from([body]) as unknown as IncomingMessage & {
    url: string
    method: string
    headers: Record<string, string>
    rawHeaders: string[]
    socket: object
  }
  req.url = '/'
  req.method = 'POST'
  req.headers = { host: 'localhost:3000', ...headers }
  req.rawHeaders = []
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
  req.socket = {} as unknown as IncomingMessage['socket']
  return req
}

function fakeSession(lastActivity: number): {
  session: Session
  closed: () => boolean
} {
  let transportClosed = false
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
  const session = {
    transport: {
      close() {
        transportClosed = true
      },
    },
    server: {
      close() {
        return Promise.resolve()
      },
    },
    lastActivity,
  } as unknown as Session
  return { session, closed: () => transportClosed }
}

describe('routeRequest', () => {
  test('answers /health without origin validation', async () => {
    const { captured, res } = makeRes()
    await routeRequest(
      new Map(),
      plainReq({ url: '/health', method: 'GET' }),
      res,
      3000,
    )
    expect(captured.statusCode).toBe(200)
    expect(JSON.parse(captured.body!).status).toBe('healthy')
  })

  test('rejects an invalid origin with 403', async () => {
    const { captured, res } = makeRes()
    await routeRequest(
      new Map(),
      plainReq({
        url: '/',
        method: 'POST',
        headers: {
          origin: 'https://evil.example.com',
          host: 'evil.example.com',
        },
      }),
      res,
      3000,
    )
    expect(captured.statusCode).toBe(403)
  })

  test('answers an OPTIONS preflight with CORS headers', async () => {
    const { captured, res } = makeRes()
    await routeRequest(
      new Map(),
      plainReq({
        url: '/',
        method: 'OPTIONS',
        headers: { origin: 'http://localhost:3000', host: 'localhost:3000' },
      }),
      res,
      3000,
    )
    expect(captured.statusCode).toBe(200)
    expect(captured.headers['Access-Control-Allow-Origin']).toBe(
      'http://localhost:3000',
    )
  })

  test('returns 404 for an unknown path', async () => {
    const { captured, res } = makeRes()
    await routeRequest(
      new Map(),
      plainReq({
        url: '/nope',
        method: 'GET',
        headers: { host: 'localhost:3000' },
      }),
      res,
      3000,
    )
    expect(captured.statusCode).toBe(404)
  })

  test('returns 405 for an unsupported method', async () => {
    const { captured, res } = makeRes()
    await routeRequest(
      new Map(),
      plainReq({
        url: '/',
        method: 'PUT',
        headers: { host: 'localhost:3000' },
      }),
      res,
      3000,
    )
    expect(captured.statusCode).toBe(405)
  })

  test('dispatches GET to a 404 when the session is unknown', async () => {
    const { captured, res } = makeRes()
    await routeRequest(
      new Map(),
      plainReq({
        url: '/',
        method: 'GET',
        headers: { host: 'localhost:3000' },
      }),
      res,
      3000,
    )
    expect(captured.statusCode).toBe(404)
    expect(captured.body).toMatch(/Invalid or expired session/)
  })

  test('dispatches a no-session POST to 400 for a non-initialize body', async () => {
    const { captured, res } = makeRes()
    await routeRequest(
      new Map(),
      postReq('{"jsonrpc":"2.0","method":"tools/list","id":1}'),
      res,
      3000,
    )
    expect(captured.statusCode).toBe(400)
    expect(captured.body).toMatch(/No valid session/)
  })

  test('dispatches a POST with invalid JSON to a 500', async () => {
    const { captured, res } = makeRes()
    await routeRequest(new Map(), postReq('not json at all'), res, 3000)
    expect(captured.statusCode).toBe(500)
  })
})

describe('handleGet / handleDelete', () => {
  test('handleGet 404s without a session id', async () => {
    const { captured, res } = makeRes()
    await handleGet(new Map(), plainReq({ url: '/', method: 'GET' }), res)
    expect(captured.statusCode).toBe(404)
  })

  test('handleDelete 404s without a session id', async () => {
    const { captured, res } = makeRes()
    await handleDelete(new Map(), plainReq({ url: '/', method: 'DELETE' }), res)
    expect(captured.statusCode).toBe(404)
  })
})

describe('session lifecycle', () => {
  test('reapIdleSessions destroys stale sessions and keeps fresh ones', () => {
    const sessions = new Map<string, Session>()
    const stale = fakeSession(Date.now() - 31 * 60 * 1000)
    const fresh = fakeSession(Date.now())
    sessions.set('stale', stale.session)
    sessions.set('fresh', fresh.session)
    reapIdleSessions(sessions)
    expect(sessions.has('stale')).toBe(false)
    expect(sessions.has('fresh')).toBe(true)
    expect(stale.closed()).toBe(true)
  })

  test('destroySession closes the transport and no-ops for unknown ids', () => {
    const sessions = new Map<string, Session>()
    const s = fakeSession(Date.now())
    sessions.set('s', s.session)
    destroySession(sessions, 's')
    expect(sessions.has('s')).toBe(false)
    expect(s.closed()).toBe(true)
    // No throw for a missing id.
    destroySession(sessions, 'missing')
  })
})
