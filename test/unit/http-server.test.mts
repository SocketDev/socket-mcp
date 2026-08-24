import { Readable } from 'node:stream'
import type { IncomingMessage } from 'node:http'

import type { NodeMcpRequestHandler } from '@modelcontextprotocol/node'
import { describe, expect, test } from 'vitest'

import {
  applyClientApiKey,
  handleMcpRequest,
  routeRequest,
} from '../../lib/http-server.ts'
import type { AuthenticatedRequest } from '../../lib/oauth.ts'
import {
  bodyReq,
  erroringReq,
  makeRes,
  MAX_POST_BODY_BYTES as MAX,
  plainReq,
  recordingMcpHandler,
} from './http-server-fixtures.mts'

function reqWith(authorization?: string | undefined): AuthenticatedRequest {
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

function throwingMcpHandler(message: string): NodeMcpRequestHandler {
  return () => Promise.reject(new Error(message))
}

describe('routeRequest', () => {
  test('answers /health without origin validation', async () => {
    const { captured, res } = makeRes()
    const { calls, handler } = recordingMcpHandler()
    await routeRequest(
      handler,
      plainReq({ url: '/health', method: 'GET' }),
      res,
      3000,
    )
    expect(captured.statusCode).toBe(200)
    expect(JSON.parse(captured.body!).status).toBe('healthy')
    expect(calls).toHaveLength(0)
  })

  test('answers 400 when the request target is not a parseable URL', async () => {
    const { captured, res } = makeRes()
    const { calls, handler } = recordingMcpHandler()
    // A protocol-relative target with an unparseable host: `new URL` throws
    // even with a base, so routing has to answer rather than crash.
    await routeRequest(
      handler,
      plainReq({ url: '//[', method: 'POST' }),
      res,
      3000,
    )
    expect(captured.statusCode).toBe(400)
    expect(JSON.parse(captured.body!).error).toEqual({
      code: -32_000,
      message: 'Bad Request: Invalid URL',
    })
    expect(calls).toHaveLength(0)
  })

  test('rejects a spoofed Host with no Origin header at all', async () => {
    const { captured, res } = makeRes()
    const { calls, handler } = recordingMcpHandler()
    // An origin-less request still has to clear the strict host check —
    // a missing Origin is not a bypass.
    await routeRequest(
      handler,
      plainReq({
        url: '/',
        method: 'POST',
        headers: { host: 'malicious-localhost.evil.com' },
      }),
      res,
      3000,
    )
    expect(captured.statusCode).toBe(403)
    expect(JSON.parse(captured.body!).error.message).toBe(
      'Forbidden: Invalid origin',
    )
    expect(calls).toHaveLength(0)
  })

  test('rejects an invalid origin with 403', async () => {
    const { captured, res } = makeRes()
    const { calls, handler } = recordingMcpHandler()
    await routeRequest(
      handler,
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
    expect(calls).toHaveLength(0)
  })

  test('reaches the MCP handler when the Origin is a native client against the hosted host', async () => {
    // Claude Desktop's custom connector sends Origin: https://claude.ai
    // against Host: mcp.socket.dev. That combination used to 403 before ever
    // reaching OAuth discovery or the MCP handler - this is the regression
    // test for that report.
    const { res } = makeRes()
    const { calls, handler } = recordingMcpHandler()
    await routeRequest(
      handler,
      plainReq({
        url: '/',
        method: 'GET',
        headers: { origin: 'https://claude.ai', host: 'mcp.socket.dev' },
      }),
      res,
      3000,
    )
    expect(calls).toHaveLength(1)
  })

  test('answers an OPTIONS preflight with CORS headers', async () => {
    const { captured, res } = makeRes()
    const { handler } = recordingMcpHandler()
    await routeRequest(
      handler,
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
    const { handler } = recordingMcpHandler()
    await routeRequest(
      handler,
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

  test('returns 405 for a non-MCP method', async () => {
    const { captured, res } = makeRes()
    const { calls, handler } = recordingMcpHandler()
    await routeRequest(
      handler,
      plainReq({
        url: '/',
        method: 'PUT',
        headers: { host: 'localhost:3000' },
      }),
      res,
      3000,
    )
    expect(captured.statusCode).toBe(405)
    expect(calls).toHaveLength(0)
  })

  test('dispatches GET to the MCP handler, which owns the 2025-era answer', async () => {
    const { res } = makeRes()
    const { calls, handler } = recordingMcpHandler()
    await routeRequest(
      handler,
      plainReq({
        url: '/',
        method: 'GET',
        headers: { host: 'localhost:3000' },
      }),
      res,
      3000,
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('GET')
    // A GET carries no body, so nothing is buffered or pre-parsed.
    expect(calls[0]!.parsedBody).toBeUndefined()
  })

  test('dispatches a session-teardown request to the MCP handler', async () => {
    const { res } = makeRes()
    const { calls, handler } = recordingMcpHandler()
    await routeRequest(handler, bodyReq('', { method: 'DELETE' }), res, 3000)
    expect(calls[0]!.method).toBe('DELETE')
    expect(calls).toHaveLength(1)
  })

  test('hands a stateless POST to the MCP handler pre-parsed', async () => {
    const { res } = makeRes()
    const { calls, handler } = recordingMcpHandler()
    // No prior initialize, no Mcp-Session-Id — the stateless contract.
    await routeRequest(
      handler,
      bodyReq('{"jsonrpc":"2.0","method":"tools/list","id":1}'),
      res,
      3000,
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]!.parsedBody).toEqual({
      jsonrpc: '2.0',
      method: 'tools/list',
      id: 1,
    })
  })

  test('answers a POST with malformed JSON with 400 and a parse error', async () => {
    const { captured, res } = makeRes()
    const { calls, handler } = recordingMcpHandler()
    await routeRequest(handler, bodyReq('not json at all'), res, 3000)
    expect(captured.statusCode).toBe(400)
    expect(JSON.parse(captured.body!).error.code).toBe(-32_700)
    expect(calls).toHaveLength(0)
  })

  test('forwards a Socket API key to the handler on req.auth', async () => {
    const { res } = makeRes()
    const { calls, handler } = recordingMcpHandler()
    await routeRequest(
      handler,
      bodyReq('{"jsonrpc":"2.0","method":"tools/list","id":1}', {
        headers: { authorization: 'Bearer sktsec_t_example' },
      }),
      res,
      3000,
    )
    expect(calls[0]!.auth?.token).toBe('sktsec_t_example')
  })
})

describe('handleMcpRequest', () => {
  test('reads no body for GET and passes undefined through', async () => {
    const { res } = makeRes()
    const { calls, handler } = recordingMcpHandler()
    await handleMcpRequest(handler, plainReq({ url: '/', method: 'GET' }), res)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.parsedBody).toBeUndefined()
  })

  test('passes an empty body through as undefined', async () => {
    const { res } = makeRes()
    const { calls, handler } = recordingMcpHandler()
    await handleMcpRequest(handler, bodyReq(''), res)
    expect(calls[0]!.parsedBody).toBeUndefined()
  })

  test('answers 413 when a POST body exceeds the cap', async () => {
    const { captured, res } = makeRes()
    const { calls, handler } = recordingMcpHandler()
    await handleMcpRequest(handler, bodyReq('a'.repeat(MAX + 1)), res)
    expect(captured.statusCode).toBe(413)
    expect(JSON.parse(captured.body!).error.message).toMatch(
      /Request body too large/,
    )
    expect(calls).toHaveLength(0)
  })

  test('applies the body cap to every body-bearing method', async () => {
    const { captured, res } = makeRes()
    const { calls, handler } = recordingMcpHandler()
    await handleMcpRequest(
      handler,
      bodyReq('a'.repeat(MAX + 1), { method: 'DELETE' }),
      res,
    )
    expect(captured.statusCode).toBe(413)
    expect(calls).toHaveLength(0)
  })

  test('does not double-write a 413 onto an already-answered response', async () => {
    const { captured, res } = makeRes({ headersSent: true })
    captured.statusCode = 200
    const { calls, handler } = recordingMcpHandler()
    await handleMcpRequest(handler, bodyReq('a'.repeat(MAX + 1)), res)
    // The status the earlier writer set survives; no second writeHead lands.
    expect(captured.statusCode).toBe(200)
    expect(captured.body).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  test('answers 500 when the request stream fails mid-read', async () => {
    const { captured, res } = makeRes()
    const { calls, handler } = recordingMcpHandler()
    await handleMcpRequest(handler, erroringReq('socket hang up'), res)
    // Not a size overflow, so the caller gets the internal-error code, not
    // the 413 the cap path writes.
    expect(captured.statusCode).toBe(500)
    expect(JSON.parse(captured.body!)).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32_603, message: 'Internal server error' },
    })
    expect(calls).toHaveLength(0)
  })

  test('does not double-write a 500 when the stream fails after headers went out', async () => {
    const { captured, res } = makeRes({ headersSent: true })
    captured.statusCode = 200
    const { calls, handler } = recordingMcpHandler()
    await handleMcpRequest(handler, erroringReq('socket hang up'), res)
    expect(captured.statusCode).toBe(200)
    expect(captured.body).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  test('defaults a request missing method and url to GET /', async () => {
    const { res } = makeRes()
    const { calls, handler } = recordingMcpHandler()
    const stream = Readable.from([''])
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
    const req = stream as unknown as IncomingMessage
    await handleMcpRequest(handler, req, res)
    // The adapter's request shape requires both, so routing restates them
    // rather than handing over undefined.
    expect(calls[0]!.method).toBe('GET')
    expect(calls[0]!.url).toBe('/')
  })

  test('answers 400 with JSON-RPC -32700 on malformed JSON', async () => {
    const { captured, res } = makeRes()
    const { calls, handler } = recordingMcpHandler()
    await handleMcpRequest(handler, bodyReq('{oops'), res)
    expect(captured.statusCode).toBe(400)
    expect(JSON.parse(captured.body!)).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32_700, message: 'Parse error' },
    })
    expect(calls).toHaveLength(0)
  })

  test('answers 500 when the MCP handler throws', async () => {
    const { captured, res } = makeRes()
    await handleMcpRequest(
      throwingMcpHandler('handler exploded'),
      bodyReq('{"jsonrpc":"2.0","method":"tools/list","id":1}'),
      res,
    )
    expect(captured.statusCode).toBe(500)
    expect(JSON.parse(captured.body!).error.code).toBe(-32_603)
  })

  test('leaves the response alone when the handler already answered', async () => {
    const { captured, res } = makeRes()
    const handler: NodeMcpRequestHandler = (_req, response) => {
      response.writeHead(202, { 'content-type': 'application/json' })
      response.end('{}')
      return Promise.reject(new Error('too late'))
    }
    await handleMcpRequest(
      handler,
      bodyReq('{"jsonrpc":"2.0","method":"tools/list","id":1}'),
      res,
    )
    expect(captured.statusCode).toBe(202)
  })
})
