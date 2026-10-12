import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  createConfiguredServer,
  setStaticApiKey,
} from '../../../lib/server.mts'
import { routeRequest } from '../../../lib/http-server.mts'
import { tokenIdentity } from '../../../lib/tool-audit.mts'
import { buildToolSpecs } from '../../../lib/server.mts'

const MODERN_PROTOCOL_VERSION = '2026-07-28'
const MODERN_META = {
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'audit-test', version: '1' },
  'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_VERSION,
}
const SECRET_CANARY = 'nested_synthetic_secret_canary'
const ORIGINAL_AUDIT_PATH = process.env['SOCKET_MCP_AUDIT_LOG']

let tempDirectory = ''
let auditPath = ''
let httpServer: Server | undefined
let endpoint = ''

beforeEach(() => {
  tempDirectory = mkdtempSync(path.join(tmpdir(), 'mcp-audit-dispatch-'))
  auditPath = path.join(tempDirectory, 'audit.jsonl')
  process.env['SOCKET_MCP_AUDIT_LOG'] = auditPath
  setStaticApiKey('')
})

afterEach(async () => {
  if (httpServer) {
    const activeServer = httpServer
    activeServer.closeAllConnections()
    await new Promise<void>(resolve => activeServer.close(() => resolve()))
    httpServer = undefined
  }
  setStaticApiKey('')
  if (ORIGINAL_AUDIT_PATH === undefined) {
    delete process.env['SOCKET_MCP_AUDIT_LOG']
  } else {
    process.env['SOCKET_MCP_AUDIT_LOG'] = ORIGINAL_AUDIT_PATH
  }
  if (tempDirectory) {
    rmSync(tempDirectory, { recursive: true, force: true })
    tempDirectory = ''
  }
})

function readEvents(): Record<string, unknown>[] {
  let contents: string
  try {
    contents = readFileSync(auditPath, 'utf8')
  } catch (error) {
    if (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return []
    }
    throw error
  }
  return contents
    .trimEnd()
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => {
      const value: unknown = JSON.parse(line)
      if (!isRecord(value)) {
        throw new TypeError('Invalid audit event')
      }
      return value
    })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function withLinkedClient(
  serverFactory: () => ReturnType<typeof createConfiguredServer>,
  callback: (client: Client) => Promise<void>,
): Promise<void> {
  const server = serverFactory()
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  const client = new Client(
    { name: 'audit-dispatch-test', version: '1.0.0' },
    { capabilities: {} },
  )
  try {
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    await callback(client)
  } finally {
    await client.close()
    await server.close()
  }
}

describe('MCP dispatch audit over linked SDK transport', () => {
  test('classifies an invalid regex without fetching a blob', async () => {
    await withLinkedClient(
      () => createConfiguredServer(undefined, 'stdio'),
      async client => {
        const result = await client.callTool({
          name: 'package_file_grep',
          arguments: {
            hash: 'synthetic_blob_hash',
            pattern: '[synthetic_invalid_regex',
          },
        })
        expect(result.isError).toBe(true)
        const { 0: block } = result.content
        expect(block?.type === 'text' ? block.text : '').toContain(
          'Invalid regular expression',
        )
        expect(readEvents()).toHaveLength(1)
        expect(readEvents()[0]).toMatchObject({
          tool: 'package_file_grep',
          outcome: 'invalid',
          identity: { kind: 'operator' },
          resources: [],
        })
      },
    )
  })

  test('audits only admitted calls, including denied, invalid, and unknown', async () => {
    await withLinkedClient(
      () => createConfiguredServer(undefined, 'stdio'),
      async client => {
        await client.listTools()
        expect(readEvents()).toHaveLength(0)

        const denied = await client.callTool({
          name: 'organizations',
          arguments: {},
        })
        expect(denied.isError).toBe(true)
        expect(readEvents()).toHaveLength(1)
        expect(readEvents()[0]).toMatchObject({
          event: 'socket.mcp.tool_call',
          version: 1,
          tool: 'organizations',
          outcome: 'denied',
          identity: { kind: 'operator' },
          resources: [],
        })

        const seenEventIds = new Set(
          readEvents().map(event => event['eventId']),
        )
        const specNames = buildToolSpecs().map(spec => spec.name)
        for (const name of specNames) {
          const before = readEvents().length
          const result = await client.callTool({
            name,
            arguments: {
              unexpected: { api_token: SECRET_CANARY },
            },
          })
          expect(result.isError).toBe(true)
          const events = readEvents()
          expect(events).toHaveLength(before + 1)
          expect(events.at(-1)).toMatchObject({
            tool: name,
            outcome: 'invalid',
            resources: [],
            identity: { kind: 'operator' },
          })
          const eventId = events.at(-1)?.['eventId']
          expect(typeof eventId).toBe('string')
          expect(seenEventIds.has(eventId)).toBe(false)
          seenEventIds.add(eventId)
          expect(JSON.stringify(events.at(-1))).not.toContain(SECRET_CANARY)
        }

        for (const name of ['does-not-exist', `界${'🧪'.repeat(80)}`]) {
          const before = readEvents().length
          const result = await client.callTool({ name, arguments: {} })
          expect(result.isError).toBe(true)
          const events = readEvents()
          expect(events).toHaveLength(before + 1)
          expect(events.at(-1)).toMatchObject({
            outcome: 'unknown',
            resources: [],
            identity: { kind: 'operator' },
          })
          if (name !== 'does-not-exist') {
            expect(events.at(-1)?.['truncated']).toMatchObject({ tool: true })
            expect(
              Buffer.byteLength(String(events.at(-1)?.['tool'])),
            ).toBeLessThanOrEqual(128)
          }
        }
      },
    )
  })
})

describe('MCP dispatch audit over real HTTP transport', () => {
  beforeEach(async () => {
    setStaticApiKey('synthetic_shared_fallback_key', { shared: true })
    const mcpHandler = toNodeHandler(
      createMcpHandler(context => createConfiguredServer(context, 'http')),
    )
    let port = 0
    httpServer = createServer((request, response) => {
      void routeRequest(mcpHandler, request, response, port)
    })
    const activeServer = httpServer
    await new Promise<void>(resolve =>
      activeServer.listen(0, '127.0.0.1', resolve),
    )
    const address = httpServer.address()
    port = typeof address === 'object' && address !== null ? address.port : 0
    endpoint = `http://127.0.0.1:${port}/`
  })

  test('uses anonymous or bearer identity from the real HTTP request context', async () => {
    const postCall = async (
      id: number,
      name: string,
      args: Record<string, unknown>,
      token?: string,
    ) =>
      await fetch(endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'mcp-method': 'tools/call',
          'mcp-name': name,
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name, arguments: args, _meta: MODERN_META },
        }),
      })

    const anonymousResponse = await postCall(0, 'does-not-exist', {})
    expect(
      anonymousResponse.status,
      JSON.stringify(await anonymousResponse.json()),
    ).toBe(200)
    expect(readEvents()).toHaveLength(1)
    expect(readEvents()[0]).toMatchObject({
      requestId: 0,
      outcome: 'unknown',
      identity: { kind: 'anonymous' },
    })

    const callerToken = 'synthetic_caller_bearer_token'
    const bearerResponse = await postCall(
      1,
      'alerts',
      { unexpected: { api_token: SECRET_CANARY } },
      callerToken,
    )
    expect(bearerResponse.status).toBe(200)
    const events = readEvents()
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({
      requestId: 1,
      outcome: 'invalid',
      identity: {
        kind: 'bearer',
        tokenHash: tokenIdentity(callerToken),
      },
    })
    expect(tokenIdentity('synthetic_shared_fallback_key')).not.toBe(
      tokenIdentity(callerToken),
    )
    expect(JSON.stringify(events[1])).not.toContain(callerToken)
    expect(JSON.stringify(events[1])).not.toContain(SECRET_CANARY)

    const deniedResponse = await postCall(2, 'organizations', {})
    expect(deniedResponse.status).toBe(200)
    expect(readEvents()).toHaveLength(3)
    expect(readEvents()[2]).toMatchObject({
      requestId: 2,
      outcome: 'denied',
      identity: { kind: 'anonymous' },
    })
  })
})
