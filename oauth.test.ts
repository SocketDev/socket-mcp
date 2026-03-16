#!/usr/bin/env node
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const serverPath = join(import.meta.dirname, 'index.ts')
const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => value !== undefined)
) as Record<string, string>
const oauthWellKnownPath = '/.well-known/oauth-authorization-server'
const protectedResourceMetadataPath = '/.well-known/oauth-protected-resource'
const mockIntrospectionResponses: Record<string, Record<string, unknown>> = {
  'token-without-exp': {
    active: true,
    client_id: 'oauth-test-client',
    scope: 'packages:list'
  },
  'token-with-wrong-scope': {
    active: true,
    client_id: 'oauth-test-client',
    scope: 'packages:write'
  }
}

function closeHttpServer (server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })
}

async function getFreePort (): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as AddressInfo
  await closeHttpServer(server)
  return address.port
}

async function readRequestBody (req: IncomingMessage): Promise<string> {
  let body = ''
  for await (const chunk of req) {
    body += chunk
  }

  return body
}

async function assertOAuthErrorResponse (
  response: Response,
  serverBaseUrl: string,
  expected: {
    status: number
    error: string
    errorDescription: string
  }
): Promise<void> {
  const body = await response.json() as {
    error?: string
    error_description?: string
  }

  assert.equal(response.status, expected.status)
  assert.equal(body.error, expected.error)
  assert.equal(body.error_description, expected.errorDescription)
  assert.equal(
    response.headers.get('www-authenticate'),
    `Bearer error="${expected.error}", error_description="${expected.errorDescription}", resource_metadata="${serverBaseUrl}${protectedResourceMetadataPath}"`
  )
}

async function startMockIssuer (): Promise<{
  baseUrl: string
  close: () => Promise<void>
}> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const baseUrl = `http://${req.headers.host}`
    const url = new URL(req.url || '/', baseUrl)

    if (req.method === 'GET' && url.pathname === oauthWellKnownPath) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        introspection_endpoint: `${baseUrl}/introspect`
      }))
      return
    }

    if (req.method === 'POST' && url.pathname === '/introspect') {
      const body = await readRequestBody(req)
      const token = new URLSearchParams(body).get('token')
      const introspectionResponse = token ? mockIntrospectionResponses[token] : undefined

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(introspectionResponse || { active: false }))
      return
    }

    res.writeHead(404)
    res.end('Not found')
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => { await closeHttpServer(server) }
  }
}

async function stopChildProcess (child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) {
    return
  }

  let exited = false
  const onExit = once(child, 'exit').then(() => {
    exited = true
  })

  child.kill('SIGTERM')
  await Promise.race([
    onExit,
    delay(3000).then(() => {
      if (exited || child.exitCode !== null) {
        return
      }

      child.kill('SIGKILL')
      return onExit
    })
  ])
}

async function waitForHealth (
  baseUrl: string,
  child: ReturnType<typeof spawn>,
  getOutput: () => string
): Promise<void> {
  const timeoutAt = Date.now() + 5000

  while (Date.now() < timeoutAt) {
    if (child.exitCode !== null) {
      throw new Error(`HTTP server exited before becoming ready:\n${getOutput()}`)
    }

    try {
      const response = await fetch(`${baseUrl}/health`)
      if (response.ok) {
        return
      }
    } catch {}

    await delay(100)
  }

  throw new Error(`Timed out waiting for HTTP server readiness:\n${getOutput()}`)
}

async function startOAuthHttpServer (
  issuerBaseUrl: string,
  extraEnv: Record<string, string> = {}
): Promise<{
  baseUrl: string
  close: () => Promise<void>
}> {
  const port = await getFreePort()
  let output = ''

  const child = spawn('node', ['--experimental-strip-types', serverPath], {
    cwd: import.meta.dirname,
    env: {
      ...inheritedEnv,
      MCP_HTTP_MODE: 'true',
      MCP_PORT: String(port),
      SOCKET_OAUTH_ISSUER: issuerBaseUrl,
      SOCKET_OAUTH_INTROSPECTION_CLIENT_ID: 'oauth-test-client-id',
      SOCKET_OAUTH_INTROSPECTION_CLIENT_SECRET: 'oauth-test-client-secret',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })

  const baseUrl = `http://127.0.0.1:${port}`
  await waitForHealth(baseUrl, child, () => output)

  return {
    baseUrl,
    close: async () => { await stopChildProcess(child) }
  }
}

test('stdio mode ignores partial OAuth config', async (t) => {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['--experimental-strip-types', serverPath],
    env: {
      ...inheritedEnv,
      SOCKET_API_KEY: 'test-api-key',
      SOCKET_OAUTH_ISSUER: 'https://issuer.example.test'
    }
  })

  const client = new Client(
    { name: 'oauth-stdio-test-client', version: '1.0.0' },
    { capabilities: {} }
  )

  t.after(async () => {
    await client.close().catch(() => {})
  })

  await client.connect(transport)
  const tools = await client.listTools()
  assert.ok(tools.tools.some(tool => tool.name === 'depscore'))
})

test('HTTP OAuth metadata and auth semantics', async (t) => {
  const issuer = await startMockIssuer()
  const server = await startOAuthHttpServer(issuer.baseUrl)

  t.after(async () => {
    await server.close()
    await issuer.close()
  })

  await t.test('does not expose upstream authorization server metadata', async () => {
    const response = await fetch(`${server.baseUrl}${oauthWellKnownPath}`)

    assert.equal(response.status, 404)
    assert.match(await response.text(), /not found/i)
  })

  await t.test('serves protected resource metadata pointing to the issuer', async () => {
    const response = await fetch(`${server.baseUrl}${protectedResourceMetadataPath}`)
    const metadata = await response.json() as {
      authorization_servers?: string[]
      resource?: string
    }

    assert.equal(response.status, 200)
    assert.deepEqual(metadata.authorization_servers, [issuer.baseUrl])
    assert.equal(metadata.resource, `${server.baseUrl}/`)
  })

  await t.test('ignores forwarded host and proto headers unless TRUST_PROXY is enabled', async () => {
    const response = await fetch(`${server.baseUrl}${protectedResourceMetadataPath}`, {
      headers: {
        'X-Forwarded-Host': 'attacker.example.com',
        'X-Forwarded-Proto': 'https'
      }
    })
    const metadata = await response.json() as { resource?: string }

    assert.equal(response.status, 200)
    assert.equal(metadata.resource, `${server.baseUrl}/`)

    const unauthenticatedResponse = await fetch(`${server.baseUrl}/`, {
      method: 'POST',
      headers: {
        'X-Forwarded-Host': 'attacker.example.com',
        'X-Forwarded-Proto': 'https'
      }
    })

    await assertOAuthErrorResponse(unauthenticatedResponse, server.baseUrl, {
      status: 401,
      error: 'invalid_request',
      errorDescription: 'Missing Authorization header'
    })
  })

  await t.test('returns invalid_request when the Authorization header is missing', async () => {
    const response = await fetch(`${server.baseUrl}/`, { method: 'POST' })
    await assertOAuthErrorResponse(response, server.baseUrl, {
      status: 401,
      error: 'invalid_request',
      errorDescription: 'Missing Authorization header'
    })
  })

  await t.test('returns invalid_token when introspection reports an inactive token', async () => {
    const response = await fetch(`${server.baseUrl}/`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer inactive-token'
      }
    })

    await assertOAuthErrorResponse(response, server.baseUrl, {
      status: 401,
      error: 'invalid_token',
      errorDescription: 'Invalid or expired token'
    })
  })

  await t.test('returns insufficient_scope when the token is missing required scopes', async () => {
    const response = await fetch(`${server.baseUrl}/`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-with-wrong-scope'
      }
    })

    await assertOAuthErrorResponse(response, server.baseUrl, {
      status: 403,
      error: 'insufficient_scope',
      errorDescription: 'Missing required scopes: packages:list'
    })
  })

  await t.test('accepts an active token even when introspection omits exp', async () => {
    const response = await fetch(`${server.baseUrl}/`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-without-exp',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '0.1.0',
          capabilities: {},
          clientInfo: {
            name: 'oauth-http-test-client',
            version: '1.0.0'
          }
        }
      })
    })

    const body = await response.json() as { result?: { serverInfo?: { name?: string } } }

    assert.equal(response.status, 200)
    assert.equal(body.result?.serverInfo?.name, 'socket')
  })
})

test('TRUST_PROXY enables forwarded host and proto for OAuth metadata URLs', async (t) => {
  const issuer = await startMockIssuer()
  const server = await startOAuthHttpServer(issuer.baseUrl, { TRUST_PROXY: 'true' })

  t.after(async () => {
    await server.close()
    await issuer.close()
  })

  const response = await fetch(`${server.baseUrl}${protectedResourceMetadataPath}`, {
    headers: {
      'X-Forwarded-Host': 'proxy.example.com',
      'X-Forwarded-Proto': 'https'
    }
  })
  const metadata = await response.json() as { resource?: string }

  assert.equal(response.status, 200)
  assert.equal(metadata.resource, 'https://proxy.example.com/')

  const unauthenticatedResponse = await fetch(`${server.baseUrl}/`, {
    method: 'POST',
    headers: {
      'X-Forwarded-Host': 'proxy.example.com',
      'X-Forwarded-Proto': 'https'
    }
  })

  await assertOAuthErrorResponse(unauthenticatedResponse, 'https://proxy.example.com', {
    status: 401,
    error: 'invalid_request',
    errorDescription: 'Missing Authorization header'
  })
})
