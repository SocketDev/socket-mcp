import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTerminal, type TestTerminal } from '@termless/core'
import { createXtermBackend } from '@termless/xtermjs'
import { expect, onTestFinished, test } from 'vitest'

import { SERVER_BIN } from '../../scripts/paths.mts'
import { createTestIssuer } from '../lib/oauth-issuer.mts'
import {
  normalizeOutput,
  renderScreenshot,
} from '../lib/termless/screenshot.mts'

function createSession() {
  const terminal = createTerminal({
    backend: createXtermBackend(),
    cols: 100,
    rows: 30,
  })
  onTestFinished(() => terminal.close())
  return terminal
}

async function commandEnv() {
  const dataHome = await mkdtemp(join(tmpdir(), 'socket-mcp-terminal-'))
  onTestFinished(() => rm(dataHome, { recursive: true, force: true }))
  return {
    XDG_DATA_HOME: dataHome,
    FORCE_COLOR: '0',
    MCP_HTTP_MODE: '',
    SOCKET_API_TOKEN: '',
    SOCKET_API_KEY: '',
    SOCKET_CLI_API_TOKEN: '',
    SOCKET_CLI_API_KEY: '',
    SOCKET_SECURITY_API_TOKEN: '',
    SOCKET_SECURITY_API_KEY: '',
    SOCKET_OAUTH_ISSUER: '',
    SOCKET_OAUTH_INTROSPECTION_CLIENT_ID: '',
    SOCKET_OAUTH_INTROSPECTION_CLIENT_SECRET: '',
  }
}

test('captures socket-mcp command output', async () => {
  const env = await commandEnv()
  for (const command of [
    { name: 'stdio-signed-out', args: [], output: 'discouraged fallback.' },
    {
      name: 'http-token-prompt',
      args: ['--http'],
      output: 'Please enter your Socket API key:',
    },
    {
      name: 'logout',
      args: ['logout'],
      output: 'Removed the saved Socket MCP browser sign-in.',
    },
    { name: 'help', args: ['--help'], output: 'discouraged fallback.' },
    {
      name: 'login-usage',
      args: ['login', '--invalid'],
      output: 'Usage: socket-mcp login',
    },
    {
      name: 'logout-usage',
      args: ['logout', '--invalid'],
      output: 'Usage: socket-mcp logout',
    },
  ]) {
    const terminal = await startCommand(command.args, env)
    await terminal.waitFor(command.output, 5000)
    await snapshotOutput(terminal, command.name)
  }
})

async function startCommand(
  args: string[],
  env: Record<string, string>,
  nodeArgs: string[] = [],
) {
  const terminal = createSession()
  await terminal.spawn([process.execPath, ...nodeArgs, SERVER_BIN, ...args], {
    env,
  })
  return terminal
}

async function snapshotOutput(
  terminal: TestTerminal,
  name: string,
  replacements: readonly (readonly [string, string])[] = [],
) {
  let frame = terminal
  const output = terminal.output.getText()
  const normalized = normalizeOutput(output, replacements)
  if (normalized !== output) {
    frame = createSession()
    frame.feed(normalized)
  }
  const filename = `termless.${name}.svg`
  const baseline = join(process.cwd(), 'test/snapshots/termless', filename)
  const dir = join(
    process.env['SOCKET_MCP_TERMINAL_ARTIFACTS'] ??
      join(process.cwd(), '.cache/terminal-screenshots'),
    name,
  )
  await mkdir(dir, { recursive: true })
  const actualPath = join(dir, 'actual.svg')
  await writeFile(actualPath, renderScreenshot(frame))
  try {
    await expect(await readFile(actualPath, 'utf8')).toMatchFileSnapshot(
      baseline,
    )
  } catch (error) {
    await writeFile(join(dir, 'output.txt'), frame.screen.getText())
    await copyFile(baseline, join(dir, 'expected.svg')).catch(
      (copyError: NodeJS.ErrnoException) => {
        if (copyError.code !== 'ENOENT') {
          throw copyError
        }
      },
    )
    throw error
  }
}

test('shows the HTTP startup banner and handles an empty prompt', async () => {
  const env = await commandEnv()
  const empty = await startCommand(['--http'], env)
  await empty.waitFor('Please enter your Socket API key:', 5000)
  empty.press('Enter')
  await empty.waitFor('No API key provided', 5000)
  await snapshotOutput(empty, 'http-empty-token')

  const http = await startCommand(['--http'], {
    ...env,
    MCP_PORT: '0',
    SOCKET_API_TOKEN: 'test-placeholder',
  })
  await http.waitFor('Connect to: http://localhost:', 5000)
  const port = http.output
    .getText()
    .match(/Connect to: http:\/\/localhost:(\d+)\//u)?.[1]
  if (!port) {
    throw new Error('Missing listening port')
  }
  await snapshotOutput(http, 'http-started', [[port, '<port>']])
})

test.each(['accepted', 'declined'] as const)(
  'shows %s browser sign-in',
  async outcome => {
    const issuer = await createTestIssuer()
    onTestFinished(() => issuer.server[Symbol.asyncDispose]())
    const env = {
      ...(await commandEnv()),
      SOCKET_MCP_OAUTH_BASE_URL: issuer.url,
    }
    const login = await startCommand(['login'], env, [
      '--disable-warning=ExperimentalWarning',
      '--permission',
      '--allow-fs-read=*',
      `--allow-fs-write=${env.XDG_DATA_HOME}`,
      ...(process.allowedNodeEnvironmentFlags.has('--allow-net')
        ? ['--allow-net']
        : []),
    ])
    await login.waitFor('Use the sign-in URL printed above.', 5000)
    const url = login.output.getText().match(/visit: (http:\/\/[^\s]+)/u)?.[1]
    if (!url) {
      throw new Error('Missing browser sign-in URL')
    }
    const authorization = new URL(url)
    const callback = new URL(
      authorization.searchParams.get('redirect_uri') ?? '',
    )
    const state = authorization.searchParams.get('state')
    const challenge = authorization.searchParams.get('code_challenge')
    if (!state || !challenge) {
      throw new Error('Missing OAuth parameters')
    }
    const replacements = [
      [state, '<state>'],
      [challenge, '<challenge>'],
      [callback.port, '<callback-port>'],
      [new URL(issuer.url).port, '<issuer-port>'],
    ] as const
    callback.searchParams.set('state', state)
    if (outcome === 'declined') {
      callback.searchParams.set('error', 'access_denied')
      expect((await fetch(callback)).status).toBe(400)
      await login.waitFor('Authorization was declined.', 5000)
      await snapshotOutput(login, 'login-declined', replacements)
      return
    }
    await snapshotOutput(login, 'login-browser', replacements)
    callback.searchParams.set('code', 'local-test-code')
    expect((await fetch(callback)).ok).toBe(true)
    await login.waitFor('Socket MCP browser sign-in saved for this user.', 5000)
    await snapshotOutput(login, 'login-saved', replacements)
    const stdio = await startCommand([], env)
    await stdio.waitFor('started successfully', 5000)
    await snapshotOutput(stdio, 'stdio-signed-in')
    const credentials = join(env.XDG_DATA_HOME, 'socket-mcp', 'oauth.json')
    const expired = {
      version: 1,
      issuer: issuer.url,
      resource: issuer.url + '/',
      tokenEndpoint: issuer.url + '/token',
      clientId: 'loopback-test-client',
      accessToken: 'test-placeholder',
      scopes: ['packages:list', 'alerts:list', 'threat-feed:list'],
      expiresAt: 1,
    }
    await writeFile(credentials, JSON.stringify(expired))
    const stale = await startCommand([], env)
    await stale.waitFor('saved sign-in expired', 5000)
    await snapshotOutput(stale, 'stdio-session-expired')
    for (const [contents, reason] of [
      ['{}', 'invalid'],
      ['{', 'corrupt'],
    ] as const) {
      await writeFile(credentials, contents)
      const invalid = await startCommand([], env)
      await invalid.waitFor(`Saved session is ${reason}`, 5000)
      await snapshotOutput(invalid, `stdio-session-${reason}`)
    }
  },
)

test('shows CLI startup diagnostics', async () => {
  const env = await commandEnv()
  const raw = await startCommand([], {
    ...env,
    SOCKET_API_TOKEN: 'test-placeholder',
  })
  await raw.waitFor('started successfully', 5000)
  await snapshotOutput(raw, 'stdio-token')
  const invalid = await startCommand(['login'], {
    ...env,
    SOCKET_MCP_OAUTH_BASE_URL: 'invalid',
  })
  await invalid.waitFor('SOCKET_MCP_OAUTH_BASE_URL', 5000)
  await snapshotOutput(invalid, 'login-invalid-url')
  const partial = await startCommand(['--http'], {
    ...env,
    SOCKET_OAUTH_ISSUER: 'https://issuer.example',
  })
  await partial.waitFor('together.', 5000)
  await snapshotOutput(partial, 'http-incomplete-oauth')
})

test('shows OAuth discovery success and failure in HTTP mode', async () => {
  const issuer = await createTestIssuer()
  onTestFinished(() => issuer.server[Symbol.asyncDispose]())
  const env = {
    ...(await commandEnv()),
    SOCKET_DEBUG: '1',
    MCP_PORT: '0',
    SOCKET_OAUTH_INTROSPECTION_CLIENT_ID: 'terminal-client',
    SOCKET_OAUTH_INTROSPECTION_CLIENT_SECRET: 'test-placeholder',
    SOCKET_OAUTH_ISSUER: issuer.url,
  }
  const http = await startCommand(['--http'], env)
  await http.waitFor('Connect to: http://localhost:', 5000)
  const port = http.output
    .getText()
    .match(/Connect to: http:\/\/localhost:(\d+)\//u)?.[1]
  if (!port) {
    throw new Error('Missing listening port')
  }
  await snapshotOutput(http, 'http-oauth-started', [
    [issuer.url, 'http://127.0.0.1:<issuer-port>'],
    [port, '<port>'],
  ])
  const missing = await startCommand(['--http'], {
    ...env,
    SOCKET_OAUTH_ISSUER: issuer.url + '/missing',
  })
  await missing.waitFor('Failed to initialize OAuth metadata', 5000)
  await snapshotOutput(missing, 'http-oauth-discovery-failed', [
    [issuer.url, 'http://127.0.0.1:<issuer-port>'],
  ])
})
