import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, test, vi } from 'vitest'

import type { Server } from 'node:http'

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }))

vi.mock(import('node:child_process'), async importOriginal => {
  const actual = await importOriginal()
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double keeps the real spawn signature while supplying only the child methods used by openBrowser.
  return { ...actual, spawn: mockSpawn as typeof actual.spawn }
})

import {
  loginWithBrowserOAuth,
  resolveLocalOAuthSession,
} from '../../../lib/local-oauth.mts'

let server: Server | undefined
let dataHome: string | undefined

afterEach(async () => {
  vi.unstubAllEnvs()
  mockSpawn.mockReset()
  if (server) {
    const listeningServer = server
    server = undefined
    listeningServer.closeAllConnections()
    await new Promise<void>(resolve => listeningServer.close(() => resolve()))
  }
  if (dataHome) {
    const directory = dataHome
    dataHome = undefined
    await fs.rm(directory, { recursive: true, force: true })
  }
})

function sendJson(
  response: import('node:http').ServerResponse,
  body: Record<string, unknown>,
): void {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

async function readBody(request: import('node:http').IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
    string,
    unknown
  >
}

async function startFakeIssuer(
  options: { tokenEndpoint?: string } = {},
): Promise<string> {
  server = createServer(async (request, response) => {
    const address = server!.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected the fake OAuth issuer to listen on TCP')
    }
    const baseUrl = 'http://127.0.0.1:' + address.port + '/'
    if (request.url === '/.well-known/oauth-protected-resource') {
      sendJson(response, {
        resource: baseUrl,
        authorization_servers: [baseUrl.slice(0, -1)],
        scopes_supported: ['packages:list', 'alerts:list', 'threat-feed:list'],
      })
      return
    }
    if (request.url === '/.well-known/oauth-authorization-server') {
      sendJson(response, {
        issuer: baseUrl.slice(0, -1),
        authorization_endpoint: baseUrl + 'authorize',
        registration_endpoint: baseUrl + 'register',
        token_endpoint: options.tokenEndpoint ?? baseUrl + 'token',
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      })
      return
    }
    if (request.method === 'POST' && request.url === '/register') {
      const registration = await readBody(request)
      sendJson(response, {
        client_id: 'loopback-test-client',
        redirect_uris: registration['redirect_uris'],
        grant_types: registration['grant_types'],
        response_types: registration['response_types'],
        token_endpoint_auth_method: 'none',
      })
      return
    }
    if (request.method === 'POST' && request.url === '/token') {
      sendJson(response, {
        access_token: 'loopback-access-token',
        refresh_token: 'loopback-refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'packages:list alerts:list threat-feed:list',
      })
      return
    }
    response.writeHead(404).end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Expected the fake OAuth issuer to listen on TCP')
  }
  return 'http://127.0.0.1:' + address.port
}

function completeBrowserAuthorization(_command: string, args: string[]) {
  const authorizationUrl = new URL(args.at(-1)!)
  const callbackUrl = new URL(
    authorizationUrl.searchParams.get('redirect_uri')!,
  )
  callbackUrl.searchParams.set('code', 'loopback-auth-code')
  callbackUrl.searchParams.set(
    'state',
    authorizationUrl.searchParams.get('state')!,
  )
  void fetch(callbackUrl)
  return { once: vi.fn(), unref: vi.fn() }
}

test('login uses the explicit loopback issuer override', async () => {
  const baseUrl = await startFakeIssuer()
  dataHome = await fs.mkdtemp(path.join(os.tmpdir(), 'socket-mcp-oauth-'))
  vi.stubEnv('SOCKET_API_BASE_URL', 'http://127.0.0.1:1')
  vi.stubEnv('SOCKET_MCP_OAUTH_BASE_URL', baseUrl)
  vi.stubEnv('XDG_DATA_HOME', dataHome)
  mockSpawn.mockImplementation(completeBrowserAuthorization)

  await loginWithBrowserOAuth()

  expect(await resolveLocalOAuthSession()).toMatchObject({
    accessToken: 'loopback-access-token',
  })
  const saved = JSON.parse(
    await fs.readFile(path.join(dataHome, 'socket-mcp', 'oauth.json'), 'utf8'),
  ) as Record<string, unknown>
  expect(saved).toMatchObject({
    issuer: baseUrl,
    resource: baseUrl + '/',
  })
  expect(mockSpawn).toHaveBeenCalledOnce()
})

test('a saved OAuth session is rejected after switching issuers', async () => {
  const baseUrl = await startFakeIssuer()
  dataHome = await fs.mkdtemp(path.join(os.tmpdir(), 'socket-mcp-oauth-'))
  vi.stubEnv('SOCKET_API_BASE_URL', baseUrl)
  vi.stubEnv('XDG_DATA_HOME', dataHome)
  mockSpawn.mockImplementation(completeBrowserAuthorization)
  await loginWithBrowserOAuth()

  vi.stubEnv('SOCKET_API_BASE_URL', 'http://127.0.0.1:1')
  await expect(resolveLocalOAuthSession()).rejects.toThrow(
    /Saved session is invalid/,
  )
})

test('OAuth metadata cannot direct token requests to another origin', async () => {
  const baseUrl = await startFakeIssuer({
    tokenEndpoint: 'https://attacker.example/token',
  })
  vi.stubEnv('SOCKET_MCP_OAUTH_BASE_URL', baseUrl)

  await expect(loginWithBrowserOAuth()).rejects.toThrow(/untrusted endpoint/)
  expect(mockSpawn).not.toHaveBeenCalled()
})
