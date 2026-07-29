/**
 * @file CLI startup decisions. `runSocketMcpCli` takes every environment read
 *   and every effect as a dependency, so each case builds the deps it needs
 *   and asserts the exit code plus which transport was handed off to. No
 *   process env is mutated and no transport is really started.
 */

import { describe, expect, test, vi } from 'vitest'

import {
  createSocketMcpCliDeps,
  INCOMPLETE_OAUTH_CONFIG_MSG,
  logStdioTransportError,
  reportSocketMcpStartupFailure,
  runSocketMcpCli,
} from '../../lib/cli.ts'
import type { SocketMcpCliDeps } from '../../lib/cli.ts'
import { logger } from '../../lib/logger.ts'

// What startup did with the deps it was handed.
interface Recorded {
  httpPorts: number[]
  prompted: number
  staticKeys: Array<{ key: string; shared: boolean | undefined }>
  stdioStarts: number
}

// Build a recording deps bag. Overrides replace individual fields so a case
// only states what it cares about.
function recordingDeps(overrides?: Partial<SocketMcpCliDeps> | undefined): {
  deps: SocketMcpCliDeps
  recorded: Recorded
} {
  const recorded: Recorded = {
    httpPorts: [],
    prompted: 0,
    staticKeys: [],
    stdioStarts: 0,
  }
  const base: SocketMcpCliDeps = {
    anyOAuthConfig: false,
    apiToken: 'static-token',
    argv: ['node', 'socket-mcp'],
    envHttpMode: false,
    loadOAuthMetadata: () => Promise.resolve({}),
    port: 3000,
    promptForApiKey: () => {
      recorded.prompted += 1
      return Promise.resolve('prompted-token')
    },
    serveStdio: () => {
      recorded.stdioStarts += 1
      return { close: () => Promise.resolve() }
    },
    setOauthEnabled: () => undefined,
    setStaticApiKey: (value, options) => {
      recorded.staticKeys.push({ key: value, shared: options?.shared })
    },
    startHttpServer: port => {
      recorded.httpPorts.push(port)
    },
  }
  return { deps: { ...base, ...overrides }, recorded }
}

// Silence the logger for a case and hand back everything it was told.
function captureErrors(): { read: () => string; restore: () => void } {
  const spy = vi.spyOn(logger, 'error').mockImplementation(() => logger)
  return {
    read: () => spy.mock.calls.map(call => String(call[0])).join('\n'),
    restore: () => spy.mockRestore(),
  }
}

describe('createSocketMcpCliDeps', () => {
  test('snapshots the real environment and wires the real effects', () => {
    const deps = createSocketMcpCliDeps()
    expect(typeof deps.anyOAuthConfig).toBe('boolean')
    expect(['string', 'undefined']).toContain(typeof deps.apiToken)
    expect(typeof deps.envHttpMode).toBe('boolean')
    expect(deps.argv).toBe(process.argv)
    expect(deps.port).toBeGreaterThan(0)
    for (const name of [
      'loadOAuthMetadata',
      'promptForApiKey',
      'serveStdio',
      'setOauthEnabled',
      'setStaticApiKey',
      'startHttpServer',
    ] as const) {
      expect(typeof deps[name]).toBe('function')
    }
  })
})

describe('transport selection', () => {
  test('serves stdio by default', async () => {
    const { deps, recorded } = recordingDeps()
    await expect(runSocketMcpCli(deps)).resolves.toBe(0)
    expect(recorded.stdioStarts).toBe(1)
    expect(recorded.httpPorts).toEqual([])
    // The stdio static key is the local user's own token, so it stays usable
    // by every tool.
    expect(recorded.staticKeys).toEqual([
      { key: 'static-token', shared: false },
    ])
  })

  test('serves HTTP when MCP_HTTP_MODE is set', async () => {
    const { deps, recorded } = recordingDeps({
      envHttpMode: true,
      port: 4242,
    })
    await expect(runSocketMcpCli(deps)).resolves.toBe(0)
    expect(recorded.httpPorts).toEqual([4242])
    expect(recorded.stdioStarts).toBe(0)
    // The HTTP static key belongs to the deploy operator, so per-tenant tools
    // must not fall back to it.
    expect(recorded.staticKeys).toEqual([{ key: 'static-token', shared: true }])
  })

  test('serves HTTP when --http is passed', async () => {
    const { deps, recorded } = recordingDeps({
      argv: ['node', 'socket-mcp', '--http'],
      port: 8080,
    })
    await expect(runSocketMcpCli(deps)).resolves.toBe(0)
    expect(recorded.httpPorts).toEqual([8080])
  })

  test('reports the failure and exits 1 when the stdio transport throws', async () => {
    const { deps } = recordingDeps({
      serveStdio: () => {
        throw new Error('stdin is gone')
      },
    })
    const errors = captureErrors()
    try {
      await expect(runSocketMcpCli(deps)).resolves.toBe(1)
      expect(errors.read()).toContain(
        'Failed to start Socket MCP server: stdin is gone',
      )
    } finally {
      errors.restore()
    }
  })
})

describe('auth preconditions', () => {
  test('refuses HTTP mode with a partial OAuth configuration', async () => {
    const { deps, recorded } = recordingDeps({
      anyOAuthConfig: true,
      envHttpMode: true,
      setOauthEnabled: () => undefined,
    })
    const errors = captureErrors()
    try {
      await expect(runSocketMcpCli(deps)).resolves.toBe(1)
      expect(errors.read()).toContain(INCOMPLETE_OAUTH_CONFIG_MSG)
      expect(recorded.httpPorts).toEqual([])
      expect(recorded.staticKeys).toEqual([])
    } finally {
      errors.restore()
    }
  })

  test('refuses stdio mode when no token alias is set', async () => {
    const { deps, recorded } = recordingDeps({ apiToken: undefined })
    const errors = captureErrors()
    try {
      await expect(runSocketMcpCli(deps)).resolves.toBe(1)
      expect(errors.read()).toContain(
        'SOCKET_API_TOKEN environment variable is required in stdio mode',
      )
      expect(recorded.stdioStarts).toBe(0)
    } finally {
      errors.restore()
    }
  })

  test('prompts for a token in HTTP mode when none is set', async () => {
    const { deps, recorded } = recordingDeps({
      apiToken: '',
      envHttpMode: true,
    })
    const errors = captureErrors()
    try {
      await expect(runSocketMcpCli(deps)).resolves.toBe(0)
      expect(recorded.prompted).toBe(1)
      expect(recorded.staticKeys).toEqual([
        { key: 'prompted-token', shared: true },
      ])
    } finally {
      errors.restore()
    }
  })

  test('skips the token prompt when OAuth is serving the auth', async () => {
    const { deps, recorded } = recordingDeps({
      anyOAuthConfig: true,
      apiToken: '',
      envHttpMode: true,
      setOauthEnabled: () => ({ issuer: 'https://issuer.example.test' }),
    })
    await expect(runSocketMcpCli(deps)).resolves.toBe(0)
    expect(recorded.prompted).toBe(0)
    expect(recorded.staticKeys).toEqual([{ key: '', shared: true }])
    expect(recorded.httpPorts).toEqual([3000])
  })

  test('exits 1 when OAuth metadata discovery fails', async () => {
    const { deps, recorded } = recordingDeps({
      anyOAuthConfig: true,
      envHttpMode: true,
      loadOAuthMetadata: () => Promise.reject(new Error('issuer unreachable')),
      setOauthEnabled: () => ({ issuer: 'https://issuer.example.test' }),
    })
    const errors = captureErrors()
    try {
      await expect(runSocketMcpCli(deps)).resolves.toBe(1)
      expect(errors.read()).toContain(
        'Failed to initialize OAuth metadata: issuer unreachable',
      )
      expect(recorded.httpPorts).toEqual([])
    } finally {
      errors.restore()
    }
  })
})

describe('logStdioTransportError', () => {
  test('reports a transport error through the logger', () => {
    const errors = captureErrors()
    try {
      logStdioTransportError(new Error('framing error'))
      expect(errors.read()).toBe('Socket MCP stdio error: framing error')
    } finally {
      errors.restore()
    }
  })
})

describe('reportSocketMcpStartupFailure', () => {
  test('reports the failure and marks the process as failed', () => {
    const errors = captureErrors()
    const priorExitCode = process.exitCode
    try {
      reportSocketMcpStartupFailure(new Error('deps blew up'))
      expect(errors.read()).toBe('Socket MCP startup failed: deps blew up')
      expect(process.exitCode).toBe(1)
    } finally {
      process.exitCode = priorExitCode
      errors.restore()
    }
  })
})
