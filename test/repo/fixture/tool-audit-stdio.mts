import { createServer } from 'node:http'
import process from 'node:process'

import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

import { SERVER_SOURCE } from '../../../scripts/repo/paths.mts'

const FIXTURE_NETWORK_GUARD = new URL(
  '../e2e/fixture/network.mts',
  import.meta.url,
).href
const MAX_CAPTURED_STDERR_BYTES = 64 * 1024
const STDERR_WAIT_TIMEOUT_MS = 5_000
const TOKEN_CANARY = 'synthetic_stdio_token_canary'

const controlledKeys = [
  'SOCKET_API_TOKEN',
  'SOCKET_API_KEY',
  'SOCKET_CLI_API_TOKEN',
  'SOCKET_CLI_API_KEY',
  'SOCKET_SECURITY_API_TOKEN',
  'SOCKET_SECURITY_API_KEY',
  'SOCKET_OAUTH_ISSUER',
  'SOCKET_OAUTH_INTROSPECTION_CLIENT_ID',
  'SOCKET_OAUTH_INTROSPECTION_CLIENT_SECRET',
  'SOCKET_OAUTH_REQUIRED_SCOPES',
  'SOCKET_OAUTH_REQUIRE_AUDIENCE',
  'MCP_HTTP_MODE',
  'MCP_PORT',
  'SOCKET_DEBUG',
  'SOCKET_MCP_AUDIT_LOG',
  'SOCKET_MCP_AUDIT_SINK',
  'SOCKET_API_BASE_URL',
  'SOCKET_CLI_API_BASE_URL',
  'SOCKET_SECURITY_API_BASE_URL',
] as const

export interface FixtureReply {
  readonly body: string
  readonly contentType: string
  readonly status: number
}

export interface StdioAuditFixture {
  readonly endpoint: string
  readonly requestCount: number
  setReply(reply: FixtureReply): void
  close(): Promise<void>
}

export interface ManagedChild {
  readonly client: Client
  readonly close: () => Promise<void>
  readonly stderrText: () => string
  readonly stderrOverflowed: () => boolean
}

export async function startApiFixture(): Promise<StdioAuditFixture> {
  let reply: FixtureReply = {
    body: '',
    contentType: 'application/json',
    status: 200,
  }
  let requestCount = 0
  const server = createServer((request, response) => {
    request.resume()
    requestCount += 1
    response.writeHead(reply.status, { 'content-type': reply.contentType })
    response.end(reply.body)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new TypeError('Loopback API fixture did not bind to a TCP port')
  }
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    get requestCount() {
      return requestCount
    },
    setReply(value) {
      reply = value
    },
    async close() {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

export async function startServerChild(
  endpoint: string,
  auditPath: string,
  sink: string,
): Promise<ManagedChild> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  for (const key of controlledKeys) delete env[key]
  env['SOCKET_API_TOKEN'] = TOKEN_CANARY
  env['SOCKET_API_BASE_URL'] =
    `${endpoint}/v0/purl?alerts=false&compact=false&fixable=false&licenseattrib=false&licensedetails=false`
  env['SOCKET_MCP_AUDIT_LOG'] = auditPath
  env['SOCKET_MCP_AUDIT_SINK'] = sink
  env['SOCKET_DEBUG'] = '1'

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', FIXTURE_NETWORK_GUARD, SERVER_SOURCE],
    cwd: process.cwd(),
    env,
    stderr: 'pipe',
  })
  const stderr = transport.stderr
  if (!stderr)
    throw new TypeError('Stdio transport did not provide its stderr pipe')
  let stderrText = ''
  let stderrBytes = 0
  let stderrOverflowed = false
  const stderrEnded = new Promise<void>(resolve => {
    stderr.once('end', resolve)
    stderr.once('close', resolve)
  })
  stderr.on('data', (chunk: unknown) => {
    const text =
      typeof chunk === 'string'
        ? chunk
        : Buffer.isBuffer(chunk)
          ? chunk.toString('utf8')
          : ''
    stderrBytes += Buffer.byteLength(text, 'utf8')
    if (stderrBytes > MAX_CAPTURED_STDERR_BYTES) {
      stderrOverflowed = true
    } else {
      stderrText += text
    }
  })
  const client = new Client(
    { name: 'stdio-audit-test', version: '1.0.0' },
    { capabilities: {} },
  )
  try {
    await client.connect(transport)
  } catch (error) {
    await transport.close()
    throw error
  }
  let closed = false
  return {
    client,
    stderrText: () => stderrText,
    stderrOverflowed: () => stderrOverflowed,
    async close() {
      if (closed) return
      closed = true
      await client.close()
      await Promise.race([
        stderrEnded,
        new Promise<void>((_resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Timed out draining child stderr')),
            STDERR_WAIT_TIMEOUT_MS,
          )
          timer.unref()
        }),
      ])
    },
  }
}
