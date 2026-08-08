/**
 * @file The HTTP transport's wire contract, driven against a real
 *   `node:http` server wired the way `startHttpServer` wires one. The
 *   2026-07-28 revision serves statelessly — no `initialize` handshake, no
 *   `Mcp-Session-Id` — while the 2025-era handshake keeps working through the
 *   handler's legacy fallback.
 */
import { createServer } from 'node:http'
import type { Server } from 'node:http'

import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { httpRequest } from '@socketsecurity/lib-stable/http-request/request'
import type { HttpResponse } from '@socketsecurity/lib-stable/http-request/response-types'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { routeRequest } from '../../lib/http-server.ts'
import { createConfiguredServer } from '../../lib/server.ts'

const MODERN_PROTOCOL_VERSION = '2026-07-28'
const LEGACY_PROTOCOL_VERSION = '2025-06-18'
const MAX_POST_BODY_BYTES = 4 * 1024 * 1024

// The per-request `_meta` envelope every 2026-07-28 request carries. Paired
// with the `Mcp-Method` header, it is what routes a request to modern serving.
const MODERN_META = {
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'contract', version: '0.0.0' },
  'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_VERSION,
}

let httpServer: Server
let endpoint: string

// The slice of a `tools/list` wire response these cases read.
interface WireToolsListMessage {
  result: {
    cacheScope?: string | undefined
    tools: Array<{ name: string }>
    ttlMs?: number | undefined
  }
}

// The SSE-framed response body carries the JSON-RPC message on a `data:`
// line. Legacy serving always frames this way — the 2025 `enableJsonResponse`
// knob has no equivalent on the handler's legacy fallback leg.
function parseSseData(text: string): unknown {
  const line = text.split(/\r?\n/).find(l => l.startsWith('data: '))
  if (!line) {
    throw new Error(`No SSE data frame in response: ${text}`)
  }
  return JSON.parse(line.slice('data: '.length))
}

async function postJson(
  body: unknown,
  headers?: Record<string, string> | undefined,
): Promise<HttpResponse> {
  return await httpRequest(endpoint, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function postModern(
  method: string,
  params?: Record<string, unknown> | undefined,
  extraHeaders?: Record<string, string> | undefined,
): Promise<HttpResponse> {
  return await postJson(
    {
      jsonrpc: '2.0',
      id: 1,
      method,
      params: { ...params, _meta: MODERN_META },
    },
    { 'mcp-method': method, ...extraHeaders },
  )
}

beforeEach(async () => {
  // One handler for the server, exactly as startHttpServer builds it.
  const mcpHandler = toNodeHandler(createMcpHandler(createConfiguredServer))
  let port = 0
  httpServer = createServer((req, res) => {
    void routeRequest(mcpHandler, req, res, port)
  })
  await new Promise<void>(resolve => {
    httpServer.listen(0, '127.0.0.1', resolve)
  })
  const address = httpServer.address()
  port = typeof address === 'object' && address ? address.port : 0
  endpoint = `http://127.0.0.1:${port}/`
})

afterEach(async () => {
  httpServer.closeAllConnections()
  await new Promise<void>(resolve => {
    httpServer.close(() => resolve())
  })
})

describe('stateless serving', () => {
  test('answers tools/call with no prior initialize and no session id', async () => {
    const res = await postModern(
      'tools/call',
      { name: 'organizations', arguments: {} },
      { 'mcp-name': 'organizations' },
    )
    expect(res.status).toBe(200)
    expect(res.headers['mcp-session-id']).toBeUndefined()
    // No token is configured, so the tool answers with its structured
    // AUTH_REQUIRED result — the point is that the call was served at all.
    expect(res.json()).toMatchObject({
      id: 1,
      jsonrpc: '2.0',
      result: { isError: true },
    })
  })

  test('answers tools/list with no prior initialize and no session id', async () => {
    const res = await postModern('tools/list')
    expect(res.status).toBe(200)
    expect(res.headers['mcp-session-id']).toBeUndefined()
    const message = res.json<WireToolsListMessage>()
    expect(message.result.tools.map(t => t.name)).toContain('depscore')
  })

  test('stamps the configured cache metadata onto a 2026-era tools/list', async () => {
    const message = (
      await postModern('tools/list')
    ).json<WireToolsListMessage>()
    expect(message.result.ttlMs).toBe(3_600_000)
    expect(message.result.cacheScope).toBe('public')
  })

  test('a modern client lists tools and reads the cache metadata', async () => {
    const client = new Client(
      { name: 'modern', version: '0.0.0' },
      { versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } },
    )
    const transport = new StreamableHTTPClientTransport(new URL(endpoint))
    try {
      await client.connect(transport)
      const listed = await client.listTools()
      expect(listed.tools.map(t => t.name)).toContain('depscore')
      expect(listed['ttlMs']).toBe(3_600_000)
      expect(listed['cacheScope']).toBe('public')
    } finally {
      await client.close()
    }
  })

  test('a modern client dispatches tools/call', async () => {
    const client = new Client(
      { name: 'modern-call', version: '0.0.0' },
      { versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } },
    )
    const transport = new StreamableHTTPClientTransport(new URL(endpoint))
    try {
      await client.connect(transport)
      const result = await client.callTool({
        name: 'does-not-exist',
        arguments: {},
      })
      expect(result.isError).toBe(true)
      const [block] = result.content
      expect(block?.type === 'text' && block.text).toMatch(
        /Unknown tool: does-not-exist/,
      )
    } finally {
      await client.close()
    }
  })
})

describe('2025-era compatibility', () => {
  test('answers a legacy initialize handshake, SSE-framed', async () => {
    const res = await postJson({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'legacy', version: '0.0.0' },
      },
    })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/event-stream/)
    expect(res.headers['mcp-session-id']).toBeUndefined()
    expect(parseSseData(res.text())).toMatchObject({
      id: 1,
      result: {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        serverInfo: { name: 'socket' },
      },
    })
  })

  test('serves a bare tools/list with no handshake at all', async () => {
    const res = await postJson({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(res.status).toBe(200)
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the SSE frame is untyped JSON; the fields read on the next line are asserted immediately.
    const message = parseSseData(res.text()) as WireToolsListMessage
    expect(message.result.tools.map(t => t.name)).toContain('depscore')
  })

  test('a legacy client completes the handshake and lists tools', async () => {
    const client = new Client({ name: 'legacy', version: '0.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(endpoint))
    try {
      await client.connect(transport)
      const { tools } = await client.listTools()
      expect(tools.map(t => t.name)).toContain('depscore')
    } finally {
      await client.close()
    }
  })
})

describe('error and limit handling', () => {
  test('answers malformed JSON with 400 and JSON-RPC -32700', async () => {
    const res = await postJson('not json at all')
    expect(res.status).toBe(400)
    expect(res.json()).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32_700, message: 'Parse error' },
    })
  })

  test('answers a GET with the adapter native 405', async () => {
    const res = await httpRequest(endpoint, {
      headers: { accept: 'text/event-stream' },
    })
    expect(res.status).toBe(405)
    expect(res.json()).toMatchObject({
      error: { code: -32_000, message: 'Method not allowed.' },
    })
  })

  test('answers a session-teardown request with the adapter native 405', async () => {
    const res = await httpRequest(endpoint, { method: 'DELETE' })
    expect(res.status).toBe(405)
    expect(res.json()).toMatchObject({
      error: { code: -32_000, message: 'Method not allowed.' },
    })
  })

  test('answers a non-MCP method with our own 405', async () => {
    const res = await httpRequest(endpoint, { method: 'PUT' })
    expect(res.status).toBe(405)
    expect(res.text()).toBe('Method not allowed')
  })

  test('answers a body over the 4 MB cap with a deliverable 413', async () => {
    // The oversized upload stops being read at the cap, but the socket stays
    // alive until the response has flushed, so the client reads the 413
    // instead of a socket error.
    const res = await postJson('a'.repeat(MAX_POST_BODY_BYTES + 1))
    expect(res.status).toBe(413)
    expect(res.json()).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32_600, message: 'Request body too large' },
    })
    expect((await postModern('tools/list')).status).toBe(200)
  })

  test('answers /health without an Origin header', async () => {
    const res = await httpRequest(`${endpoint}health`)
    expect(res.status).toBe(200)
    expect(res.json()).toMatchObject({
      service: 'socket-mcp',
      status: 'healthy',
    })
  })
})
