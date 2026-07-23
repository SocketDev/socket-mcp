import { createServer } from 'node:http'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { describe, expect, test } from 'vitest'

import { routeRequest } from '../../lib/http-server.ts'
import type { Session } from '../../lib/http-server.ts'

describe('http-server integration', () => {
  test('initializes a real session, lists tools, and tears down', async () => {
    const sessions = new Map<string, Session>()
    let port = 0
    const server = createServer((req, res) => {
      void routeRequest(sessions, req, res, port)
    })
    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    port = typeof address === 'object' && address ? address.port : 0

    const client = new Client(
      { name: 'integration', version: '0.0.0' },
      { capabilities: {} },
    )
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/`),
    )
    try {
      // connect() POSTs the initialize request — exercises the new-session
      // branch (server creation, transport wiring, onsessioninitialized).
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
      await client.connect(transport as Transport)
      expect(sessions.size).toBe(1)

      // A follow-up call routes to the established session.
      const { tools } = await client.listTools()
      expect(tools.map(t => t.name)).toContain('depscore')

      // close() issues DELETE, which destroys the session server-side.
      await client.close()
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => {
        server.close(() => resolve())
      })
    }
  })
})
