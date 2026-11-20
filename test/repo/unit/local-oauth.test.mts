import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, test, vi } from 'vitest'

import { createTestIssuer } from '../../lib/oauth-issuer.mts'

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

async function startFakeIssuer(
  options: { tokenEndpoint?: string } = {},
): Promise<string> {
  const issuer = await createTestIssuer(options)
  server = issuer.server
  return issuer.url
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
