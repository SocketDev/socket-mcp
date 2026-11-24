/**
 * @file Error reporting end to end against the built bin. A local fake Socket
 *   API answers every request with a 500, and a local recorder stands in for
 *   Sentry's envelope endpoint. The HTTP server started with a DSN must send
 *   one scrubbed event for a failing tool call and still stop promptly on
 *   SIGTERM; started without a DSN, or in stdio mode with one, it must send
 *   nothing. No real network is reached.
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { tokenIdentity } from '../../lib/tool-audit.mts'
import { SERVER_BIN } from '../../scripts/paths.mts'

const CALLER_TOKEN = 'synthetic_e2e_caller_token'
const DEPLOY_TOKEN = 'synthetic_e2e_deploy_token'
const ORG_SLUG = 'synthetic-e2e-secret-org'
const BODY_CANARY = 'synthetic_e2e_upstream_body'
const NETWORK_FIXTURE = new URL('./fixture/network.mts', import.meta.url).href

interface RunningServer {
  child: ChildProcess
  endpoint: string
  output: () => string
}

let fakeApi: Server
let recorder: Server
let apiBaseUrl = ''
let dsn = ''
let auditDirectory = ''
const envelopes: string[] = []

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(
        typeof address === 'object' && address !== null ? address.port : 0,
      )
    })
  })
}

function close(server: Server): Promise<void> {
  server.closeAllConnections()
  return new Promise(resolve => server.close(() => resolve()))
}

function serveFailingApi(request: IncomingMessage, response: ServerResponse) {
  request.resume()
  response.writeHead(500, { 'content-type': 'text/plain' })
  response.end(`${BODY_CANARY} ${request.url}`)
}

function recordEnvelope(request: IncomingMessage, response: ServerResponse) {
  let body = ''
  request.setEncoding('utf8')
  request.on('data', chunk => {
    body += chunk
  })
  request.on('end', () => {
    envelopes.push(body)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{}')
  })
}

function serverEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'] ?? '',
    SOCKET_API_BASE_URL: apiBaseUrl,
    SOCKET_API_TOKEN: DEPLOY_TOKEN,
    SOCKET_MCP_AUDIT_LOG: path.join(auditDirectory, 'audit.jsonl'),
    ...extra,
  }
}

// Start the built bin in HTTP mode and wait for its listening banner.
async function startHttpServer(
  extra: Record<string, string>,
): Promise<RunningServer> {
  const child = spawn(
    process.execPath,
    ['--import', NETWORK_FIXTURE, SERVER_BIN],
    {
      env: serverEnv({ MCP_HTTP_MODE: 'true', MCP_PORT: '0', ...extra }),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let output = ''
  const port = await new Promise<number>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      output += chunk.toString()
      const match = /started successfully on port (\d+)/u.exec(output)
      if (match) {
        resolve(Number(match[1]))
      }
    }
    child.stdout!.on('data', onData)
    child.stderr!.on('data', onData)
    child.once('exit', code => {
      reject(new Error(`server exited early (${code}): ${output}`))
    })
  })
  return {
    child,
    endpoint: `http://127.0.0.1:${port}/`,
    output: () => output,
  }
}

function stop(server: RunningServer): Promise<NodeJS.Signals | null> {
  return new Promise(resolve => {
    if (server.child.exitCode !== null || server.child.signalCode !== null) {
      resolve(server.child.signalCode)
      return
    }
    server.child.once('exit', (_code, signal) => resolve(signal))
    server.child.kill('SIGTERM')
  })
}

async function callFailingAlerts(endpoint: string): Promise<string> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${CALLER_TOKEN}`,
      'content-type': 'application/json',
      'mcp-method': 'tools/call',
      'mcp-name': 'alerts',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'alerts',
        arguments: { org_slug: ORG_SLUG, per_page: 5 },
        _meta: {
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': {
            name: 'e2e-client',
            version: '9.9.9',
          },
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        },
      },
    }),
  })
  expect(response.status).toBe(200)
  return await response.text()
}

async function waitForEnvelopes(count: number): Promise<void> {
  const deadline = Date.now() + 5000
  while (envelopes.length < count && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

function eventPayloads(): Array<Record<string, unknown>> {
  return envelopes.flatMap(envelope => {
    const lines = envelope.split('\n').filter(Boolean)
    const events: Array<Record<string, unknown>> = []
    for (let i = 1; i + 1 < lines.length; i += 2) {
      if (lines[i]!.includes('"type":"event"')) {
        events.push(JSON.parse(lines[i + 1]!))
      }
    }
    return events
  })
}

beforeAll(async () => {
  auditDirectory = mkdtempSync(path.join(tmpdir(), 'mcp-sentry-e2e-'))
  fakeApi = createServer(serveFailingApi)
  recorder = createServer(recordEnvelope)
  apiBaseUrl = `http://127.0.0.1:${await listen(fakeApi)}`
  dsn = `http://public@127.0.0.1:${await listen(recorder)}/1`
})

afterAll(async () => {
  await close(fakeApi)
  await close(recorder)
  rmSync(auditDirectory, { recursive: true, force: true })
})

describe('HTTP server with SOCKET_MCP_SENTRY_DSN', () => {
  test('sends one scrubbed event for an upstream 500 and stops on SIGTERM', async () => {
    envelopes.length = 0
    const server = await startHttpServer({
      SOCKET_MCP_SENTRY_DSN: dsn,
      SOCKET_MCP_SENTRY_ENVIRONMENT: 'e2e',
    })
    try {
      expect(server.output()).toContain(
        'Error reporting to Sentry is on (environment e2e)',
      )
      expect(await callFailingAlerts(server.endpoint)).toContain(
        '"isError":true',
      )
      await waitForEnvelopes(1)
    } finally {
      // SIGTERM runs the shutdown flush, then the default signal action.
      const started = Date.now()
      expect(await stop(server)).toBe('SIGTERM')
      expect(Date.now() - started).toBeLessThan(3000)
    }

    const events = eventPayloads()
    expect(events).toHaveLength(1)
    const event = events[0]!
    expect(event['environment']).toBe('e2e')
    expect(event['tags']).toEqual({
      'auth.outcome': 'bearer_ok',
      'failure.cause': 'upstream_5xx',
      'mcp.client': 'e2e-client',
      'mcp.client_version': '9.9.9',
      'mcp.tool': 'alerts',
      'tool.outcome': 'failure',
      transport: 'http',
      'upstream.status': '500',
    })

    const serialized = envelopes.join('\n')
    for (const leak of [
      CALLER_TOKEN,
      tokenIdentity(CALLER_TOKEN),
      DEPLOY_TOKEN,
      ORG_SLUG,
      BODY_CANARY,
      'per_page',
      apiBaseUrl,
      SERVER_BIN,
    ]) {
      expect(serialized).not.toContain(leak)
    }
  })
})

describe('without error reporting', () => {
  test('an HTTP server without a DSN sends nothing', async () => {
    envelopes.length = 0
    const server = await startHttpServer({})
    try {
      expect(server.output()).not.toContain('Error reporting')
      expect(await callFailingAlerts(server.endpoint)).toContain(
        '"isError":true',
      )
      await new Promise(resolve => setTimeout(resolve, 500))
    } finally {
      await stop(server)
    }
    expect(envelopes).toEqual([])
  })

  test('a stdio server ignores the DSN and sends nothing', async () => {
    envelopes.length = 0
    const client = new Client(
      { name: 'e2e-stdio-client', version: '1.0.0' },
      { capabilities: {} },
    )
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', NETWORK_FIXTURE, SERVER_BIN],
      env: serverEnv({ SOCKET_MCP_SENTRY_DSN: dsn }) as Record<string, string>,
      stderr: 'pipe',
    })
    let stderr = ''
    transport.stderr?.on('data', chunk => {
      stderr += String(chunk)
    })
    await client.connect(transport)
    try {
      const result = await client.callTool({
        name: 'alerts',
        arguments: { org_slug: ORG_SLUG },
      })
      expect(result.isError).toBe(true)
      await new Promise(resolve => setTimeout(resolve, 500))
    } finally {
      await client.close().catch(() => {})
    }
    expect(stderr).not.toContain('Error reporting')
    expect(envelopes).toEqual([])
  })
})
