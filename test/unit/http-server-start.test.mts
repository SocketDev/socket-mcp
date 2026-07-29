/**
 * @file `startHttpServer` boot coverage. The function owns the wiring — build
 *   the MCP handler, create the server, route through `routeRequest`, listen —
 *   but hands back no handle, so `node:http` is mocked purely to capture the
 *   created server and close it afterwards. Everything the cases assert goes
 *   over a real loopback socket.
 */

import { once } from 'node:events'
import { createServer } from 'node:http'
import type { Server } from 'node:http'

import { httpRequest } from '@socketsecurity/lib-stable/http-request/request'
import { afterEach, expect, test, vi } from 'vitest'

import { startHttpServer } from '../../lib/http-server.ts'

const { createdServers } = vi.hoisted(() => ({
  createdServers: [] as Server[],
}))

vi.mock(import('node:http'), async importOriginal => {
  const actual = await importOriginal()
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- node:http's createServer is overloaded, so the pass-through wrapper is retyped back to the original signature.
  const capturingCreateServer = ((...args: unknown[]) => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- same overload pass-through: the arguments are forwarded verbatim.
    const create = actual.createServer as unknown as (
      ...forwarded: unknown[]
    ) => Server
    const server = create(...args)
    createdServers.push(server)
    return server
  }) as unknown as typeof actual.createServer
  return { ...actual, default: actual, createServer: capturingCreateServer }
})

// Bind an ephemeral port, read it back, and release it — startHttpServer
// takes a concrete port, so the free one has to be found first.
async function reserveFreePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>(resolve => {
    probe.listen(0, '127.0.0.1', resolve)
  })
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>(resolve => {
    probe.close(() => resolve())
  })
  return port
}

// Boot the server the way production does and wait for the socket to be up.
async function bootServer(port: number): Promise<Server> {
  startHttpServer(port)
  const server = createdServers.at(-1)!
  await once(server, 'listening')
  return server
}

afterEach(async () => {
  const pending = createdServers.splice(0, createdServers.length)
  await Promise.allSettled(
    pending.map(async server => {
      server.closeAllConnections()
      await new Promise<void>(resolve => {
        server.close(() => resolve())
      })
    }),
  )
})

test('startHttpServer serves /health on the requested port', async () => {
  const port = await reserveFreePort()
  await bootServer(port)

  const res = await httpRequest(`http://127.0.0.1:${port}/health`)
  expect(res.status).toBe(200)
  expect(res.json()).toMatchObject({ service: 'socket-mcp', status: 'healthy' })
})

test('startHttpServer wires the MCP handler onto the listening server', async () => {
  const port = await reserveFreePort()
  await bootServer(port)

  const res = await httpRequest(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-method': 'tools/list',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {
        _meta: {
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': {
            name: 'start-http-server',
            version: '0.0.0',
          },
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        },
      },
    }),
  })
  expect(res.status).toBe(200)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the wire response is untyped JSON; the field read on the next line is asserted immediately.
  const message = res.json() as { result: { tools: Array<{ name: string }> } }
  expect(message.result.tools.map(tool => tool.name)).toContain('depscore')
})
