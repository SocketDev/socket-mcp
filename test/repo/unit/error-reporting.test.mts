/**
 * @file Error reporting's decisions in isolation: it stays off (and never
 *   loads the Sentry module) without a DSN or in stdio mode, which tool calls
 *   earn an event, how the bounded tags are derived, and what the event
 *   sanitizer lets through. The HTTP-driven cases live in
 *   test/repo/integration/error-reporting.test.mts.
 */

import type { ErrorEvent } from '@sentry/core'
import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  closeErrorReporting,
  errorCodeTag,
  errorTypeName,
  flushErrorReporting,
  initErrorReporting,
  isErrorReportingEnabled,
  isReportableToolCall,
  reportServerError,
  reportToolCall,
  resolveAuthOutcome,
  resolveMcpClient,
} from '../../../lib/error-reporting.mts'
import { logger } from '../../../lib/logger.mts'

// Count how often the lazily loaded Sentry module is evaluated.
const sentryModule = vi.hoisted(() => ({ loads: 0 }))
vi.mock('../../../lib/error-reporting-sentry.mts', async importOriginal => {
  sentryModule.loads += 1
  return await importOriginal()
})

afterEach(async () => {
  await closeErrorReporting()
  vi.restoreAllMocks()
})

// These run first: once a later case loads the Sentry module, the count can
// no longer show that the off path skipped it.
describe('when no DSN is set or the transport is stdio', () => {
  test('does not load Sentry, send anything or report', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await expect(
      initErrorReporting({ dsn: undefined, mode: 'http' }),
    ).resolves.toBe(false)
    await expect(initErrorReporting({ dsn: '', mode: 'http' })).resolves.toBe(
      false,
    )
    await expect(
      initErrorReporting({ dsn: 'http://public@127.0.0.1:9/1', mode: 'stdio' }),
    ).resolves.toBe(false)
    expect(isErrorReportingEnabled()).toBe(false)

    reportToolCall({
      clientInfo: undefined,
      error: new Error('boom'),
      identity: { kind: 'anonymous' },
      outcome: 'failure',
      threw: true,
      tool: 'depscore',
      transport: 'http',
      userAgent: undefined,
    })
    reportServerError(new Error('boom'), { source: 'mcp_adapter' })
    await expect(flushErrorReporting(10)).resolves.toBe(true)

    expect(sentryModule.loads).toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('initErrorReporting', () => {
  test('logs and stays off when the DSN does not parse', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const dsn of [
      'not a dsn',
      'ftp://public@127.0.0.1/1',
      'http://127.0.0.1/1',
      'http://public@127.0.0.1/project',
    ]) {
      await expect(initErrorReporting({ dsn, mode: 'http' })).resolves.toBe(
        false,
      )
    }
    expect(consoleError).not.toHaveBeenCalled()
    expect(isErrorReportingEnabled()).toBe(false)
    // A DSN is what loads the Sentry module at all.
    expect(sentryModule.loads).toBe(1)
    expect(warn).toHaveBeenCalledWith(
      'SOCKET_MCP_SENTRY_DSN is not a valid Sentry DSN; error reporting is off',
    )
    // The log line never echoes the DSN.
    expect(JSON.stringify(warn.mock.calls)).not.toContain('not a dsn')
  })
})

describe('resolveMcpClient', () => {
  test('prefers clientInfo and normalizes it', () => {
    expect(
      resolveMcpClient({ name: 'Claude Code', version: '2.1.4' }, 'curl/8'),
    ).toEqual({ name: 'claude-code', version: '2.1.4' })
  })

  test('falls back to the User-Agent product token', () => {
    expect(
      resolveMcpClient(undefined, 'Cursor/1.7.2 (darwin arm64) node/24'),
    ).toEqual({ name: 'cursor', version: '1.7.2' })
    expect(resolveMcpClient({ name: '  ' }, 'python-httpx/0.28.1')).toEqual({
      name: 'python-httpx',
      version: '0.28.1',
    })
    expect(resolveMcpClient(undefined, 'node')).toEqual({
      name: 'node',
      version: undefined,
    })
  })

  test('answers unknown without either', () => {
    expect(resolveMcpClient(undefined, undefined)).toEqual({ name: 'unknown' })
    expect(resolveMcpClient('not an object', '   ')).toEqual({
      name: 'unknown',
    })
  })

  test('bounds the name and drops versions that do not look like one', () => {
    const client = resolveMcpClient(
      { name: `${'x'.repeat(200)}`, version: 'v'.repeat(80) },
      undefined,
    )
    expect(client.name).toHaveLength(64)
    expect(client.version).toBeUndefined()
    expect(
      resolveMcpClient({ name: 'ok', version: '1.0.0 <script>' }, undefined),
    ).toEqual({ name: 'ok', version: undefined })
  })
})

describe('resolveAuthOutcome', () => {
  test('separates a caller token upstream rejected from one it accepted', () => {
    const bearer = { kind: 'bearer', tokenHash: 'sha256:0' } as const
    expect(resolveAuthOutcome(bearer, undefined)).toBe('bearer_ok')
    expect(resolveAuthOutcome(bearer, 'upstream_5xx')).toBe('bearer_ok')
    expect(resolveAuthOutcome(bearer, 'upstream_denied')).toBe('bearer_denied')
  })

  test('blames the deploy token when an anonymous call is rejected upstream', () => {
    expect(resolveAuthOutcome({ kind: 'anonymous' }, undefined)).toBe(
      'anonymous',
    )
    expect(resolveAuthOutcome({ kind: 'anonymous' }, 'upstream_denied')).toBe(
      'operator_denied',
    )
    expect(resolveAuthOutcome({ kind: 'operator' }, 'thrown')).toBe('operator')
  })
})

describe('isReportableToolCall', () => {
  test('reports server-side failures', () => {
    expect(isReportableToolCall('failure', 'thrown', 'bearer_ok')).toBe(true)
    for (const cause of [
      'upstream_5xx',
      'network',
      'timeout',
      'exception',
    ] as const) {
      expect(isReportableToolCall('failure', cause, 'anonymous')).toBe(true)
    }
    expect(
      isReportableToolCall('denied', 'upstream_denied', 'operator_denied'),
    ).toBe(true)
  })

  test('leaves caller-side outcomes to breadcrumbs', () => {
    expect(isReportableToolCall('invalid', undefined, 'bearer_ok')).toBe(false)
    expect(isReportableToolCall('unknown', undefined, 'anonymous')).toBe(false)
    expect(
      isReportableToolCall('denied', 'upstream_denied', 'bearer_denied'),
    ).toBe(false)
    expect(isReportableToolCall('denied', undefined, 'anonymous')).toBe(false)
    expect(isReportableToolCall('failure', 'upstream_4xx', 'bearer_ok')).toBe(
      false,
    )
    expect(isReportableToolCall('failure', undefined, 'bearer_ok')).toBe(false)
    expect(isReportableToolCall('success', undefined, 'bearer_ok')).toBe(false)
  })
})

describe('error tags', () => {
  test('keeps only identifier-shaped codes and type names', () => {
    expect(
      errorCodeTag(Object.assign(new Error('x'), { code: 'ECONNRESET' })),
    ).toBe('ECONNRESET')
    expect(
      errorCodeTag(Object.assign(new Error('x'), { code: 'not a code' })),
    ).toBeUndefined()
    expect(errorTypeName(new TypeError('x'))).toBe('TypeError')
    expect(
      errorTypeName(Object.assign(new Error('x'), { name: 'Bad Name!' })),
    ).toBe('Error')
    expect(errorTypeName('thrown string')).toBe('string')
  })
})

describe('sanitizeEvent', () => {
  test('rebuilds the event from the allowlist', async () => {
    const { sanitizeEvent } =
      await import('../../../lib/error-reporting-sentry.mts')
    const secret = 'synthetic_secret_value'
    const event: ErrorEvent = {
      type: undefined,
      event_id: 'abc123',
      timestamp: 1,
      level: 'error',
      platform: 'node',
      release: '0.0.0-test',
      environment: 'test',
      server_name: `host-${secret}`,
      message: `message ${secret}`,
      user: { id: secret, ip_address: '10.0.0.1' },
      request: {
        url: `https://example.test/?token=${secret}`,
        headers: { authorization: `Bearer ${secret}` },
        query_string: `token=${secret}`,
      },
      extra: { args: { org_slug: secret } },
      contexts: { os: { name: secret } },
      tags: {
        'mcp.tool': 'alerts',
        'failure.cause': 'upstream_5xx',
        'upstream.status': '502',
        'auth.outcome': 'bearer_ok',
        secret_tag: secret,
        'mcp.client': `${secret} with spaces`,
      },
      fingerprint: ['socket-mcp', 'tool', 'alerts', `fp ${secret}`],
      breadcrumbs: [
        { category: 'mcp', message: 'tool call', data: { tool: 'alerts' } },
        { category: 'http', message: `GET https://example.test/${secret}` },
        {
          category: 'mcp',
          message: `odd ${secret} message!`,
          data: { url: `https://example.test/?q=${secret}` },
        },
      ],
      exception: {
        values: [
          {
            type: 'Error',
            value: `connect ECONNREFUSED ${secret}`,
            mechanism: { type: 'chained', source: 'cause', exception_id: 1 },
          },
          {
            type: 'UpstreamHttpError',
            value: `alerts endpoint 502: ${secret}`,
            mechanism: { type: 'socket-mcp', handled: true, exception_id: 0 },
            stacktrace: {
              frames: [
                {
                  function: 'fetchAlerts',
                  filename: `/Users/${secret}/project/dist/index.cjs`,
                  abs_path: `/Users/${secret}/project/dist/index.cjs`,
                  lineno: 10,
                  colno: 2,
                  in_app: true,
                  vars: { token: secret },
                  context_line: `const token = '${secret}'`,
                  module: secret,
                },
                {
                  function: 'processTicksAndRejections',
                  filename: 'node:internal/process/task_queues',
                },
              ],
            },
          },
        ],
      },
    }

    const safe = sanitizeEvent(event)
    expect(JSON.stringify(safe)).not.toContain(secret)
    expect(safe.tags).toEqual({
      'auth.outcome': 'bearer_ok',
      'failure.cause': 'upstream_5xx',
      'mcp.tool': 'alerts',
      'upstream.status': '502',
    })
    expect(safe.exception?.values?.map(value => value.value)).toEqual([
      '[redacted]',
      'alerts upstream_5xx 502',
    ])
    expect(safe.exception?.values?.[1]?.stacktrace?.frames).toEqual([
      {
        function: 'fetchAlerts',
        filename: 'index.cjs',
        lineno: 10,
        colno: 2,
        in_app: true,
      },
      {
        function: 'processTicksAndRejections',
        filename: 'node:internal/process/task_queues',
      },
    ])
    expect(safe.fingerprint).toEqual(['socket-mcp', 'tool', 'alerts'])
    expect(safe.breadcrumbs).toEqual([
      { category: 'mcp', message: 'tool call', data: { tool: 'alerts' } },
      { category: 'mcp', message: '[redacted]', data: {} },
    ])
    for (const key of [
      'server_name',
      'message',
      'user',
      'request',
      'extra',
    ] as const) {
      expect(safe[key]).toBeUndefined()
    }
    expect(Object.keys(safe.contexts ?? {})).toEqual(['runtime'])
  })
})
