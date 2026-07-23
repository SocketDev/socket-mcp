import path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { expect, onTestFinished, test } from 'vitest'

const serverPath = path.join(import.meta.dirname, '..', '..', 'index.ts')
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => value !== undefined),
) as Record<string, string>

// Both env-var names are valid entry points — the canonical name is
// SOCKET_API_TOKEN, but SOCKET_API_KEY is the legacy alias more tools
// (and most local-dev setups) export, so mcp's local getSocketApiToken
// shim walks the fleet-canonical chain. Cover both so a future drop of
// either alias surfaces here, not in a user report.
// socket-api-token-env: bootstrap -- this array tests the alias-normalization shim.
const SOCKET_API_TOKEN_ALIASES = [
  'SOCKET_API_TOKEN',
  'SOCKET_API_KEY',
  'SOCKET_CLI_API_TOKEN',
  'SOCKET_CLI_API_KEY',
  'SOCKET_SECURITY_API_TOKEN',
  'SOCKET_SECURITY_API_KEY',
] as const
// socket-api-token-env: bootstrap -- parametrizing tests over both aliases.
for (const tokenEnvVar of ['SOCKET_API_TOKEN', 'SOCKET_API_KEY']) {
  test(`stdio mode ignores partial OAuth config (${tokenEnvVar})`, async () => {
    // stdio transport speaks over the child's stdin/stdout — no network
    // — so this spawned-server check coexists with nock.disableNetConnect.
    // Strip every alias so we're exercising exactly the env-var name
    // this case is parametrizing on — otherwise an inherited
    // SOCKET_API_KEY on the dev machine would mask the
    // SOCKET_API_TOKEN-only path.
    const cleanEnv = { ...inheritedEnv }
    for (let i = 0, { length } = SOCKET_API_TOKEN_ALIASES; i < length; i += 1) {
      delete cleanEnv[SOCKET_API_TOKEN_ALIASES[i]!]
    }
    const transport = new StdioClientTransport({
      command: 'node',
      args: [serverPath],
      env: {
        ...cleanEnv,
        [tokenEnvVar]: 'test-api-token',
        SOCKET_OAUTH_ISSUER: 'https://issuer.example.test',
      },
    })

    const client = new Client(
      { name: 'oauth-stdio-test-client', version: '1.0.0' },
      { capabilities: {} },
    )

    onTestFinished(async () => {
      await client.close().catch(() => {})
    })

    await client.connect(transport)
    const tools = await client.listTools()
    expect(tools.tools.some(tool => tool.name === 'depscore')).toBe(true)
  })
}
