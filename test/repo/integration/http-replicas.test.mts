/**
 * @file Serving across replicas behind a load balancer with no session
 *   affinity: two independent `node:http` servers wired the way
 *   `startHttpServer` wires one. A handshake on one replica must not be needed
 *   by the next request on the other, with and without OAuth.
 */
import { createServer } from 'node:http'
import type { Server } from 'node:http'

import { toNodeHandler } from '@modelcontextprotocol/node'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { httpRequest } from '@socketsecurity/lib-stable/http-request/request'
import type { HttpResponse } from '@socketsecurity/lib-stable/http-request/response-types'
import nock from 'nock'
import { afterEach, describe, expect, test, vi } from 'vitest'

const LEGACY_PROTOCOL_VERSION = '2025-06-18'
const ISSUER = 'https://issuer.example.test'

interface Replica {
  readonly endpoint: string
  readonly server: Server
}

const replicas: Replica[] = []

// Load the server modules fresh so OAuth settings stubbed into the env are
// read at module init, then start one replica on an ephemeral port.
async function startReplica(): Promise<Replica> {
  const { routeRequest } = await import('../../../lib/http-server.mts')
  const { createConfiguredServer } = await import('../../../lib/server.mts')
  const mcpHandler = toNodeHandler(createMcpHandler(createConfiguredServer))
  let port = 0
  const server = createServer((req, res) => {
    void routeRequest(mcpHandler, req, res, port)
  })
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  port = typeof address === 'object' && address !== null ? address.port : 0
  const replica = { endpoint: `http://127.0.0.1:${port}/`, server }
  replicas.push(replica)
  return replica
}

async function post(
  replica: Replica,
  body: unknown,
  headers?: Record<string, string> | undefined,
): Promise<HttpResponse> {
  return await httpRequest(replica.endpoint, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

function initializeBody() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: LEGACY_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'replica-probe', version: '0.0.0' },
    },
  }
}

function depscoreCallBody() {
  return {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'depscore',
      arguments: {
        packages: [{ ecosystem: 'npm', depname: 'express', version: '4.18.2' }],
      },
    },
  }
}

// The SSE-framed legacy response carries the JSON-RPC message on a `data:`
// line.
function parseSseData(text: string): unknown {
  const line = text.split(/\r?\n/).find(l => l.startsWith('data: '))
  if (!line) {
    throw new Error(`No SSE data frame in response: ${text}`)
  }
  return JSON.parse(line.slice('data: '.length))
}

// Expect one depscore lookup at the Socket API, sent with `token`.
function mockDepscoreUpstream(token: string): nock.Scope {
  return nock('https://api.socket.dev')
    .post('/v0/purl')
    .query(true)
    .matchHeader('authorization', `Bearer ${token}`)
    .reply(
      200,
      `${JSON.stringify({
        type: 'npm',
        name: 'express',
        version: '4.18.2',
        score: { overall: 0.8, supplyChain: 0.9 },
      })}\n`,
    )
}

function stubOAuthEnv(): void {
  vi.stubEnv('SOCKET_OAUTH_ISSUER', ISSUER)
  vi.stubEnv('SOCKET_OAUTH_INTROSPECTION_CLIENT_ID', 'introspection-client')
  vi.stubEnv('SOCKET_OAUTH_INTROSPECTION_CLIENT_SECRET', 'introspection-secret')
}

function mockIssuer(): void {
  nock('https://issuer.example.test')
    .persist()
    .get('/.well-known/oauth-authorization-server')
    .reply(200, {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      introspection_endpoint: `${ISSUER}/introspect`,
    })
}

afterEach(async () => {
  for (const { server } of replicas.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(resolve => {
      server.close(() => resolve())
    })
  }
  nock.cleanAll()
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('serving across replicas without session affinity', () => {
  test('a tools/call on one replica needs no handshake from another', async () => {
    vi.resetModules()
    const first = await startReplica()
    const second = await startReplica()
    const upstream = mockDepscoreUpstream('replica-api-token')

    const init = await post(first, initializeBody())
    expect(init.status).toBe(200)
    expect(init.headers['mcp-session-id']).toBeUndefined()

    const call = await post(second, depscoreCallBody(), {
      authorization: 'Bearer replica-api-token',
    })
    expect(call.status).toBe(200)
    expect(parseSseData(call.text())).toMatchObject({
      id: 2,
      result: {
        content: [{ type: 'text', text: expect.stringContaining('express') }],
      },
    })
    expect(upstream.isDone()).toBe(true)
  })

  test('a session id from an earlier deployment does not reject the call', async () => {
    vi.resetModules()
    const replica = await startReplica()
    const upstream = mockDepscoreUpstream('replica-api-token')

    const call = await post(replica, depscoreCallBody(), {
      authorization: 'Bearer replica-api-token',
      'mcp-session-id': 'session-from-old-deployment',
    })
    expect(call.status).toBe(200)
    expect(call.text()).not.toContain('No valid session')
    expect(upstream.isDone()).toBe(true)
  })
})

describe('the OAuth resource-server flow across replicas', () => {
  test('an anonymous initialize is challenged toward the published metadata', async () => {
    stubOAuthEnv()
    vi.resetModules()
    mockIssuer()
    const { setOauthEnabled } = await import('../../../lib/oauth.mts')
    expect(setOauthEnabled()).toEqual({ issuer: ISSUER })
    const replica = await startReplica()

    const init = await post(replica, initializeBody())
    expect(init.status).toBe(401)
    const challenge = String(init.headers['www-authenticate'])
    const metadataUrl = `${replica.endpoint}.well-known/oauth-protected-resource`
    expect(challenge).toContain(`resource_metadata="${metadataUrl}"`)

    const metadata = await httpRequest(metadataUrl)
    expect(metadata.status).toBe(200)
    expect(metadata.json()).toMatchObject({
      resource: replica.endpoint,
      authorization_servers: [ISSUER],
    })
  })

  test('an anonymous depscore call is challenged, not scored', async () => {
    stubOAuthEnv()
    vi.resetModules()
    mockIssuer()
    const { setOauthEnabled } = await import('../../../lib/oauth.mts')
    setOauthEnabled()
    const replica = await startReplica()

    const call = await post(replica, depscoreCallBody())
    expect(call.status).toBe(401)
    expect(call.json()).toMatchObject({
      error: 'invalid_request',
      error_description: 'Missing Authorization header',
    })
  })

  test('an OAuth token initializes on one replica and scores on another', async () => {
    stubOAuthEnv()
    vi.resetModules()
    mockIssuer()
    const introspection = nock('https://issuer.example.test')
      .post('/introspect')
      .twice()
      .reply(200, {
        active: true,
        client_id: 'chat-client',
        scope: 'packages:list',
      })
    const { setOauthEnabled } = await import('../../../lib/oauth.mts')
    setOauthEnabled()
    const first = await startReplica()
    const second = await startReplica()
    const upstream = mockDepscoreUpstream('oauth-access-token')
    const auth = { authorization: 'Bearer oauth-access-token' }

    const init = await post(first, initializeBody(), auth)
    expect(init.status).toBe(200)

    const call = await post(second, depscoreCallBody(), auth)
    expect(call.status).toBe(200)
    expect(parseSseData(call.text())).toMatchObject({
      id: 2,
      result: {
        content: [{ type: 'text', text: expect.stringContaining('express') }],
      },
    })
    expect(introspection.isDone()).toBe(true)
    expect(upstream.isDone()).toBe(true)
  })
})
