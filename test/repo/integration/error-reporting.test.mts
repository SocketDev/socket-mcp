/**
 * @file Error reporting through the real HTTP stack. A `node:http` server is
 *   wired exactly as `startHttpServer` wires one (both `onerror` sinks and the
 *   route-failure fallback), the Socket API is faked with nock, and Sentry
 *   sends into a recording transport. Each case asserts which calls produce
 *   exactly one event, with which tags, and that nothing from the caller's
 *   token, arguments or the upstream response reaches the envelope.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { toNodeHandler } from '@modelcontextprotocol/node'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { createTransport } from '@sentry/core'
import type { BaseTransportOptions, Transport } from '@sentry/core'
import nock from 'nock'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  closeErrorReporting,
  flushErrorReporting,
  initErrorReporting,
  reportServerError,
} from '../../../lib/error-reporting.mts'
import {
  createRouteFailureHandler,
  handleMcpAdapterError,
  handleMcpHandlerError,
  routeRequest,
} from '../../../lib/http-server.mts'
import { logger } from '../../../lib/logger.mts'
import type { AuthenticatedRequest } from '../../../lib/oauth.mts'
import {
  createConfiguredServer,
  setStaticApiKey,
} from '../../../lib/server.mts'
import { tokenIdentity } from '../../../lib/tool-audit.mts'
import { VERSION } from '../../../lib/version.mts'
import { makeRes } from '../unit/http-server-fixtures.mts'

const SOCKET_API = 'https://api.socket.dev'
const TEST_DSN = 'http://public@127.0.0.1:9/1'
const CALLER_TOKEN = 'synthetic_caller_bearer_token'
const DEPLOY_TOKEN = 'synthetic_shared_deploy_token'
const ORG_SLUG = 'synthetic-secret-org'
const PACKAGE_NAME = 'synthetic-secret-package'
const BODY_CANARY = 'synthetic_upstream_body_canary'
const MODERN_META = {
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': {
    name: 'Synthetic Client',
    version: '3.2.1',
  },
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
}
const ORIGINAL_AUDIT_PATH = process.env['SOCKET_MCP_AUDIT_LOG']
const ORIGINAL_AUDIT_SINK = process.env['SOCKET_MCP_AUDIT_SINK']

interface SentryEvent {
  breadcrumbs?: Array<{ data?: Record<string, string>; message?: string }>
  exception?: { values?: Array<{ type?: string; value?: string }> }
  fingerprint?: string[]
  release?: string
  tags?: Record<string, string>
}

let envelopes: string[] = []
let httpServer: Server
let endpoint = ''
let auditTempDirectory = ''

function recordingTransport(options: BaseTransportOptions): Transport {
  return createTransport(options, request => {
    envelopes.push(
      typeof request.body === 'string'
        ? request.body
        : new TextDecoder().decode(request.body),
    )
    return Promise.resolve({ statusCode: 200 })
  })
}

// Every event payload recorded so far, after the queue drains.
async function recordedEvents(): Promise<SentryEvent[]> {
  await flushErrorReporting(2000)
  const events: SentryEvent[] = []
  for (const envelope of envelopes) {
    const lines = envelope.split('\n').filter(Boolean)
    for (let i = 1; i + 1 < lines.length; i += 2) {
      const header: unknown = JSON.parse(lines[i]!)
      if (
        typeof header === 'object' &&
        header !== null &&
        Reflect.get(header, 'type') === 'event'
      ) {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- envelope payloads are untyped JSON; the cases assert on the fields they read.
        events.push(JSON.parse(lines[i + 1]!) as SentryEvent)
      }
    }
  }
  return events
}

async function postToolCall(
  name: string,
  args: Record<string, unknown>,
  headers?: Record<string, string> | undefined,
): Promise<Response> {
  return await fetch(endpoint, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-method': 'tools/call',
      'mcp-name': name,
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args, _meta: MODERN_META },
    }),
  })
}

const bearer = { authorization: `Bearer ${CALLER_TOKEN}` }

// A socket-level failure as Node raises it. nock needs an Error instance: a
// plain object never reaches the request's error handler, so the call would
// hang until its timeout.
function socketError(code: string): Error {
  return Object.assign(new Error(`connect ${code} ${ORG_SLUG}`), { code })
}

beforeEach(async () => {
  envelopes = []
  auditTempDirectory = mkdtempSync(path.join(tmpdir(), 'mcp-error-reporting-'))
  process.env['SOCKET_MCP_AUDIT_LOG'] = path.join(
    auditTempDirectory,
    'audit.jsonl',
  )
  process.env['SOCKET_MCP_AUDIT_SINK'] = 'jsonl'
  nock.disableNetConnect()
  nock.enableNetConnect(/^127\.0\.0\.1(?::\d+)?$/u)
  setStaticApiKey(DEPLOY_TOKEN, { shared: true })
  vi.spyOn(logger, 'error').mockImplementation(() => logger)
  vi.spyOn(logger, 'warn').mockImplementation(() => logger)
  await expect(
    initErrorReporting({
      dsn: TEST_DSN,
      mode: 'http',
      makeTransport: recordingTransport,
    }),
  ).resolves.toBe(true)

  // Wired as startHttpServer wires it.
  const mcpHandler = toNodeHandler(
    createMcpHandler(context => createConfiguredServer(context, 'http'), {
      onerror: handleMcpHandlerError,
    }),
    { onerror: handleMcpAdapterError },
  )
  let port = 0
  httpServer = createServer((req, res) => {
    routeRequest(mcpHandler, req, res, port).catch(
      createRouteFailureHandler(res, req),
    )
  })
  await new Promise<void>(resolve => {
    httpServer.listen(0, '127.0.0.1', resolve)
  })
  const address = httpServer.address()
  port = typeof address === 'object' && address !== null ? address.port : 0
  endpoint = `http://127.0.0.1:${port}/`
})

afterEach(async () => {
  await closeErrorReporting()
  vi.restoreAllMocks()
  nock.cleanAll()
  nock.enableNetConnect()
  setStaticApiKey('')
  httpServer.closeAllConnections()
  await new Promise<void>(resolve => {
    httpServer.close(() => resolve())
  })
  if (ORIGINAL_AUDIT_PATH === undefined) {
    delete process.env['SOCKET_MCP_AUDIT_LOG']
  } else {
    process.env['SOCKET_MCP_AUDIT_LOG'] = ORIGINAL_AUDIT_PATH
  }
  if (ORIGINAL_AUDIT_SINK === undefined) {
    delete process.env['SOCKET_MCP_AUDIT_SINK']
  } else {
    process.env['SOCKET_MCP_AUDIT_SINK'] = ORIGINAL_AUDIT_SINK
  }
  rmSync(auditTempDirectory, { recursive: true, force: true })
})

describe('tool calls that fail on the server side', () => {
  test('a throwing handler sends one event tagged with tool, client and auth', async () => {
    // depscore's first statement logs the request; make that dependency throw
    // so the handler itself throws.
    vi.spyOn(logger, 'info').mockImplementation((...args: unknown[]) => {
      if (args[1] === 'request received') {
        throw new TypeError(`synthetic handler bug near ${PACKAGE_NAME}`)
      }
      return logger
    })
    const res = await postToolCall(
      'depscore',
      { packages: [{ depname: PACKAGE_NAME, ecosystem: 'npm' }] },
      bearer,
    )
    expect(res.status).toBe(200)
    await res.text()

    const events = await recordedEvents()
    expect(events).toHaveLength(1)
    expect(events[0]!.tags).toEqual({
      'auth.outcome': 'bearer_ok',
      'failure.cause': 'thrown',
      'mcp.client': 'synthetic-client',
      'mcp.client_version': '3.2.1',
      'mcp.tool': 'depscore',
      'tool.outcome': 'failure',
      transport: 'http',
    })
    expect(events[0]!.fingerprint).toEqual([
      'socket-mcp',
      'tool',
      'depscore',
      'failure',
      'bearer_ok',
      'thrown',
    ])
    expect(events[0]!.release).toBe(VERSION)
    expect(events[0]!.exception?.values?.at(-1)).toMatchObject({
      type: 'TypeError',
      value: 'depscore thrown',
    })
    expect(envelopes.join('\n')).not.toContain(PACKAGE_NAME)
  })

  test('an upstream 5xx sends one event and leaks nothing from the call', async () => {
    const api = nock(SOCKET_API)
      .get(`/v0/orgs/${ORG_SLUG}/alerts`)
      .query(true)
      .reply(502, `${BODY_CANARY} for ${ORG_SLUG}`)
    const res = await postToolCall(
      'alerts',
      { org_slug: ORG_SLUG, per_page: 7, cursor: 'synthetic-cursor-canary' },
      { ...bearer, cookie: 'session=synthetic-cookie-canary' },
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('"isError":true')
    expect(api.isDone()).toBe(true)

    const events = await recordedEvents()
    expect(events).toHaveLength(1)
    expect(events[0]!.tags).toMatchObject({
      'auth.outcome': 'bearer_ok',
      'failure.cause': 'upstream_5xx',
      'mcp.tool': 'alerts',
      'tool.outcome': 'failure',
      'upstream.status': '502',
    })
    expect(events[0]!.exception?.values?.at(-1)).toMatchObject({
      type: 'UpstreamHttpError',
      value: 'alerts upstream_5xx 502',
    })

    const serialized = envelopes.join('\n')
    for (const leak of [
      CALLER_TOKEN,
      tokenIdentity(CALLER_TOKEN),
      DEPLOY_TOKEN,
      ORG_SLUG,
      BODY_CANARY,
      'synthetic-cursor-canary',
      'synthetic-cookie-canary',
      'per_page',
      'startAfterCursor',
      'Bearer',
      'authorization',
      'mcp-session-id',
      homedir(),
    ]) {
      expect(serialized).not.toContain(leak)
    }
  })

  test('a refused connection is tagged as a network failure', async () => {
    nock(SOCKET_API)
      .get(`/v0/orgs/${ORG_SLUG}/alerts`)
      .query(true)
      .replyWithError(socketError('ECONNREFUSED'))
    const res = await postToolCall('alerts', { org_slug: ORG_SLUG }, bearer)
    await res.text()

    const events = await recordedEvents()
    expect(events).toHaveLength(1)
    expect(events[0]!.tags).toMatchObject({
      'error.code': 'ECONNREFUSED',
      'failure.cause': 'network',
      'mcp.tool': 'alerts',
    })
  })

  test('a timed-out request is tagged as a timeout', async () => {
    nock(SOCKET_API)
      .get(`/v0/orgs/${ORG_SLUG}/alerts`)
      .query(true)
      .replyWithError(socketError('ETIMEDOUT'))
    const res = await postToolCall('alerts', { org_slug: ORG_SLUG }, bearer)
    await res.text()

    const events = await recordedEvents()
    expect(events).toHaveLength(1)
    expect(events[0]!.tags).toMatchObject({
      'error.code': 'ETIMEDOUT',
      'failure.cause': 'timeout',
    })
  })

  test('a rejected deploy token on an anonymous call is reported', async () => {
    nock(SOCKET_API).post('/v0/purl').query(true).reply(401, BODY_CANARY)
    const res = await postToolCall('depscore', {
      packages: [{ depname: PACKAGE_NAME, ecosystem: 'npm', version: '1.0.0' }],
    })
    await res.text()

    const events = await recordedEvents()
    expect(events).toHaveLength(1)
    expect(events[0]!.tags).toMatchObject({
      'auth.outcome': 'operator_denied',
      'failure.cause': 'upstream_denied',
      'mcp.tool': 'depscore',
      'tool.outcome': 'denied',
      'upstream.status': '401',
    })
    expect(envelopes.join('\n')).not.toContain(DEPLOY_TOKEN)
  })

  test('a 2025-era call without clientInfo is named by its User-Agent', async () => {
    nock(SOCKET_API)
      .get(`/v0/orgs/${ORG_SLUG}/alerts`)
      .query(true)
      .reply(503, BODY_CANARY)
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'user-agent': 'Synthetic-Legacy-Agent/4.5.6 (synthetic; os)',
        ...bearer,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'alerts', arguments: { org_slug: ORG_SLUG } },
      }),
    })
    expect(res.status).toBe(200)
    await res.text()

    const events = await recordedEvents()
    expect(events).toHaveLength(1)
    expect(events[0]!.tags).toMatchObject({
      'failure.cause': 'upstream_5xx',
      'mcp.client': 'synthetic-legacy-agent',
      'mcp.client_version': '4.5.6',
    })
  })
})

describe('tool calls the caller got wrong', () => {
  test('invalid, unknown, denied and 4xx calls leave breadcrumbs, not events', async () => {
    nock(SOCKET_API)
      .get(`/v0/orgs/${ORG_SLUG}/alerts`)
      .query(true)
      .reply(401, BODY_CANARY)
      .get(`/v0/orgs/${ORG_SLUG}/alerts`)
      .query(true)
      .reply(404, BODY_CANARY)
    const unknownTool = 'synthetic_unknown_tool_name'
    for (const [name, args, headers] of [
      ['alerts', { org_slug: 42 }, bearer],
      [unknownTool, {}, bearer],
      ['organizations', {}, {}],
      ['alerts', { org_slug: ORG_SLUG }, bearer],
      ['alerts', { org_slug: ORG_SLUG }, bearer],
    ] as const) {
      const res = await postToolCall(name, { ...args }, { ...headers })
      expect(res.status).toBe(200)
      await res.text()
    }
    expect(await recordedEvents()).toEqual([])

    // The next real failure carries them as context.
    nock(SOCKET_API)
      .get(`/v0/orgs/${ORG_SLUG}/alerts`)
      .query(true)
      .reply(500, BODY_CANARY)
    await (await postToolCall('alerts', { org_slug: ORG_SLUG }, bearer)).text()
    const events = await recordedEvents()
    expect(events).toHaveLength(1)
    expect(events[0]!.breadcrumbs?.map(crumb => crumb.data)).toEqual([
      {
        'auth.outcome': 'bearer_ok',
        'mcp.tool': 'alerts',
        'tool.outcome': 'invalid',
      },
      {
        'auth.outcome': 'bearer_ok',
        'mcp.tool': 'unknown',
        'tool.outcome': 'unknown',
      },
      {
        'auth.outcome': 'anonymous',
        'mcp.tool': 'organizations',
        'tool.outcome': 'denied',
      },
      {
        'auth.outcome': 'bearer_denied',
        'failure.cause': 'upstream_denied',
        'mcp.tool': 'alerts',
        'tool.outcome': 'denied',
      },
      {
        'auth.outcome': 'bearer_ok',
        'failure.cause': 'upstream_4xx',
        'mcp.tool': 'alerts',
        'tool.outcome': 'failure',
      },
    ])
    expect(envelopes.join('\n')).not.toContain(unknownTool)
  })
})

describe('server errors outside tool handlers', () => {
  test('a serving failure in the MCP handler sends one event', async () => {
    handleMcpHandlerError(new Error(`synthetic serving failure ${ORG_SLUG}`))
    const events = await recordedEvents()
    expect(events).toHaveLength(1)
    expect(events[0]!.tags).toEqual({
      'auth.outcome': 'unknown',
      'error.source': 'mcp_handler',
      'mcp.client': 'unknown',
      'mcp.tool': 'unknown',
      transport: 'http',
    })
    expect(events[0]!.fingerprint).toEqual([
      'socket-mcp',
      'server',
      'mcp_handler',
      'Error',
    ])
    expect(envelopes.join('\n')).not.toContain(ORG_SLUG)
  })

  test('a request the MCP handler rejects for the client is not reported', async () => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'text/plain',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(res.status).toBe(415)
    expect(await recordedEvents()).toEqual([])
  })

  test('an adapter failure sends one event, a client abort none', async () => {
    const abort = new Error('This operation was aborted')
    abort.name = 'AbortError'
    handleMcpAdapterError(abort)
    expect(await recordedEvents()).toEqual([])

    handleMcpAdapterError(new Error('synthetic adapter failure'))
    const events = await recordedEvents()
    expect(events).toHaveLength(1)
    expect(events[0]!.tags).toMatchObject({ 'error.source': 'mcp_adapter' })
  })

  test('an unexpected routing exception sends one event with request context', async () => {
    const { res } = makeRes()
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double: the handler reads only the headers and auth members.
    const req = {
      headers: { 'user-agent': 'Synthetic-Router-Client/1.0.0' },
      auth: { token: CALLER_TOKEN, clientId: 'socket-api-key', scopes: [] },
    } as unknown as AuthenticatedRequest & IncomingMessage
    createRouteFailureHandler(res, req)(new TypeError('synthetic routing bug'))

    const events = await recordedEvents()
    expect(events).toHaveLength(1)
    expect(events[0]!.tags).toMatchObject({
      'auth.outcome': 'bearer_ok',
      'error.source': 'http_route',
      'mcp.client': 'synthetic-router-client',
      'mcp.client_version': '1.0.0',
    })
    expect(envelopes.join('\n')).not.toContain(CALLER_TOKEN)
  })

  test('a reset while verifying a token is an upstream failure, not a client abort', async () => {
    reportServerError(
      Object.assign(new Error('introspection reset'), { code: 'ECONNRESET' }),
      { source: 'oauth_verify' },
    )
    const events = await recordedEvents()
    expect(events).toHaveLength(1)
    expect(events[0]!.tags).toMatchObject({
      'error.code': 'ECONNRESET',
      'error.source': 'oauth_verify',
    })
  })
})

describe('an unreachable Sentry', () => {
  test('does not break the tool call or the flush', async () => {
    await closeErrorReporting()
    // A port that was just released, so the connection is refused.
    const closed = createServer()
    await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve))
    const address = closed.address()
    const closedPort =
      typeof address === 'object' && address !== null ? address.port : 0
    await new Promise<void>(resolve => closed.close(() => resolve()))
    await expect(
      initErrorReporting({
        dsn: `http://public@127.0.0.1:${closedPort}/1`,
        mode: 'http',
      }),
    ).resolves.toBe(true)

    nock(SOCKET_API)
      .get(`/v0/orgs/${ORG_SLUG}/alerts`)
      .query(true)
      .reply(500, BODY_CANARY)
    const res = await postToolCall('alerts', { org_slug: ORG_SLUG }, bearer)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('"isError":true')

    const started = Date.now()
    await expect(flushErrorReporting(2000)).resolves.toBeTypeOf('boolean')
    expect(Date.now() - started).toBeLessThan(2500)
  })
})
