/**
 * @file Opt-in error reporting for the HTTP server. It is off unless
 *   SOCKET_MCP_SENTRY_DSN is set, and stdio mode never turns it on. This module
 *   decides which tool calls and server errors are worth an event and which
 *   bounded tags each one carries. It loads the Sentry client
 *   (`error-reporting-sentry.mts`) with a dynamic import only once reporting
 *   is on, so a default start never evaluates the Sentry SDK and sends
 *   nothing.
 *   Events are for real failures: a tool handler throwing, an upstream 5xx,
 *   network error or timeout behind a tool, an unexpected exception while
 *   serving a request. Invalid input, unknown tools, a caller's denied token
 *   and upstream 4xx answers are the caller's doing, so they leave at most a
 *   breadcrumb.
 */

import process from 'node:process'

import type { BaseTransportOptions, Transport } from '@sentry/core'

import { logger } from './logger.mts'
import type {
  ToolAuditIdentity,
  ToolAuditOutcome,
} from './tool-audit-event.mts'
import { classifyToolFailure, errorCode } from './tool-outcome.mts'
import type { ToolFailureCause } from './tool-outcome.mts'
import { VERSION } from './version.mts'

// How a tool call's credentials fared, as far as this server can tell:
// `operator` is the local stdio user, `anonymous` an HTTP caller without a
// token, `operator_denied` an anonymous call whose fallback to the deploy's
// shared token was rejected upstream, `bearer_ok` a caller token upstream did
// not reject, and `bearer_denied` one it answered 401 or 403. `unknown` marks
// server errors raised outside any one tool call.
export type AuthOutcome =
  | 'anonymous'
  | 'bearer_denied'
  | 'bearer_ok'
  | 'operator'
  | 'operator_denied'
  | 'unknown'

export type FailureCause = ToolFailureCause | 'thrown'

// Where a server error surfaced outside a tool handler.
export type ServerErrorSource =
  | 'http_body'
  | 'http_route'
  | 'mcp_adapter'
  | 'mcp_handler'
  | 'mcp_request'
  | 'oauth_verify'

export interface ErrorReportingConfig {
  readonly dsn: string | undefined
  readonly environment?: string | undefined
  // Builds the Sentry transport. Tests pass a recording transport; the default
  // posts envelopes with the global `fetch`.
  readonly makeTransport?:
    | ((options: BaseTransportOptions) => Transport)
    | undefined
  readonly mode: 'http' | 'stdio'
  // SOCKET_MCP_SENTRY_TRACES_SAMPLE_RATE; 0 (no transactions) when unset.
  readonly tracesSampleRate?: number | undefined
}

export interface ErrorReportContext {
  readonly fingerprint: readonly string[]
  readonly tags: Readonly<Record<string, string>>
}

export interface ErrorReportBreadcrumb {
  readonly data: Readonly<Record<string, string>>
  readonly message: string
}

// The client side of reporting, which the lazily loaded Sentry module builds.
export interface ErrorReporter {
  addBreadcrumb(breadcrumb: ErrorReportBreadcrumb): void
  capture(error: unknown, context: ErrorReportContext): void
  close(timeoutMs: number): PromiseLike<boolean>
  flush(timeoutMs: number): PromiseLike<boolean>
  traceToolCall<T>(
    span: ToolCallSpan,
    run: () => Promise<T>,
    isError: () => boolean,
  ): Promise<T>
}

export interface ToolCallSpan {
  readonly client: { name: string; version?: string | undefined }
  // A registered tool name, or `unknown`.
  readonly tool: string
  readonly transport: string
}

export interface ToolCallReport {
  // `clientInfo` from the request's 2026-07-28 `_meta` envelope, unvalidated.
  readonly clientInfo: unknown
  readonly error?: unknown
  readonly identity: ToolAuditIdentity
  readonly outcome: ToolAuditOutcome
  // The handler's result, which carries the upstream failure cause.
  readonly result?: object | undefined
  readonly threw: boolean
  // A registered tool name, or `unknown`.
  readonly tool: string
  readonly transport: string
  readonly userAgent: string | undefined
}

export interface ServerErrorReport {
  readonly hasBearer?: boolean | undefined
  readonly source: ServerErrorSource
  readonly userAgent?: string | undefined
}

export const SHUTDOWN_FLUSH_TIMEOUT_MS = 2000

const CLIENT_NAME_MAX_LENGTH = 64

// User-Agent products named as a client family; any other product is
// `other`. Kept in step with the hosted proxy's map so both layers tag the
// same client the same way.
const USER_AGENT_CLIENT_FAMILIES: ReadonlyMap<string, string> = new Map([
  ['aiohttp', 'aiohttp'],
  ['axios', 'axios'],
  ['bun', 'bun'],
  ['claude-code', 'claude-code'],
  ['claude-user', 'claude-user'],
  ['codex', 'codex'],
  ['curl', 'curl'],
  ['cursor', 'cursor'],
  ['go-http-client', 'go-http-client'],
  ['mozilla', 'browser'],
  ['node', 'node'],
  ['node-fetch', 'node'],
  ['okhttp', 'okhttp'],
  ['openai-mcp', 'openai-mcp'],
  ['python-httpx', 'python-httpx'],
  ['python-requests', 'python-requests'],
  ['undici', 'node'],
  ['vscode', 'vscode'],
])

// Failure causes that point at the server side of an upstream call rather than
// at the caller's request.
const REPORTED_FAILURE_CAUSES: ReadonlySet<FailureCause> = new Set([
  'exception',
  'network',
  'thrown',
  'timeout',
  'upstream_5xx',
])

let reporter: ErrorReporter | undefined

export async function closeErrorReporting(timeoutMs = 0): Promise<void> {
  const active = reporter
  reporter = undefined
  if (active) {
    await Promise.resolve(active.close(timeoutMs)).catch(() => false)
  }
}

// A bounded `error.code` tag value, e.g. `ECONNREFUSED`.
export function errorCodeTag(error: unknown): string | undefined {
  const code = errorCode(error)
  return code !== undefined && /^[A-Z][A-Z0-9_]{1,39}$/u.test(code)
    ? code
    : undefined
}

// The error's constructor name when it reads as an identifier, for grouping.
export function errorTypeName(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z_$][\w$]{0,63}$/u.test(error.name)) {
    return error.name
  }
  return error instanceof Error ? 'Error' : typeof error
}

// Wait up to `timeoutMs` for queued events to send. Never rejects, and answers
// true when reporting is off.
export async function flushErrorReporting(timeoutMs: number): Promise<boolean> {
  const active = reporter
  if (!active) {
    return true
  }
  try {
    return await active.flush(timeoutMs)
  } catch {
    return false
  }
}

// Flush queued events when the process is asked to stop, then let the signal
// take its default course. Only the CLI installs this, once reporting is on.
export function flushErrorReportingOnSignals(
  signals: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM'],
): void {
  for (const signal of signals) {
    process.once(signal, () => {
      void flushErrorReporting(SHUTDOWN_FLUSH_TIMEOUT_MS).finally(() => {
        process.kill(process.pid, signal)
      })
    })
  }
}

/**
 * Turn reporting on when a DSN is set in HTTP mode. Answers whether it is on.
 * Without a DSN, or in stdio mode, it returns before loading the Sentry
 * module. A broken DSN or a failed load logs one line and leaves the server
 * running without reporting.
 */
export async function initErrorReporting(
  config: ErrorReportingConfig,
): Promise<boolean> {
  if (reporter) {
    return true
  }
  if (config.mode !== 'http' || !config.dsn) {
    return false
  }
  try {
    const { createSentryReporter } =
      await import('./error-reporting-sentry.mts')
    const created = createSentryReporter({
      dsn: config.dsn,
      environment: config.environment,
      makeTransport: config.makeTransport,
      release: VERSION,
      tracesSampleRate: config.tracesSampleRate,
    })
    if (!created) {
      logger.warn(
        'SOCKET_MCP_SENTRY_DSN is not a valid HTTPS Sentry DSN; error reporting is off',
      )
      return false
    }
    reporter = created
    logger.info(
      `Error reporting to Sentry is on${config.environment ? ` (environment ${config.environment})` : ''}`,
    )
    return true
  } catch (error) {
    // The message could echo the DSN, so log only the error type.
    logger.warn(
      `Error reporting could not start (${errorTypeName(error)}); continuing without it`,
    )
    return false
  }
}

// The CLI's entry: turn reporting on and, once it is on, flush queued events
// when the process is told to stop.
export async function startErrorReporting(
  config: ErrorReportingConfig,
): Promise<void> {
  if (await initErrorReporting(config)) {
    flushErrorReportingOnSignals()
  }
}

export function isErrorReportingEnabled(): boolean {
  return reporter !== undefined
}

// Whether a tool call deserves an event rather than at most a breadcrumb.
export function isReportableToolCall(
  outcome: ToolAuditOutcome,
  cause: FailureCause | undefined,
  auth: AuthOutcome,
): boolean {
  if (cause === 'thrown') {
    return true
  }
  if (outcome === 'denied') {
    return auth === 'operator_denied'
  }
  return (
    outcome === 'failure' &&
    cause !== undefined &&
    REPORTED_FAILURE_CAUSES.has(cause)
  )
}

// Name the MCP client: `clientInfo.name` when the request carried one,
// otherwise the client family of the User-Agent's first product token
// (`other` when the family is not known), otherwise `unknown`. Names are
// lowercased, reduced to [a-z0-9._-] and capped at 64 characters; a version is
// kept only when it looks like one and fits in 32, and never for `other`.
export function resolveMcpClient(
  clientInfo: unknown,
  userAgent: string | undefined,
): { name: string; version?: string | undefined } {
  if (typeof clientInfo === 'object' && clientInfo !== null) {
    const name = normalizeClientName(Reflect.get(clientInfo, 'name'))
    if (name) {
      return {
        name,
        version: normalizeClientVersion(Reflect.get(clientInfo, 'version')),
      }
    }
  }
  const product = userAgent?.trim().split(/\s+/u)[0]
  if (product) {
    const slash = product.indexOf('/')
    const productName = normalizeClientName(
      slash === -1 ? product : product.slice(0, slash),
    )
    if (productName) {
      const name = USER_AGENT_CLIENT_FAMILIES.get(productName)
      return name
        ? {
            name,
            version:
              slash === -1
                ? undefined
                : normalizeClientVersion(product.slice(slash + 1)),
          }
        : { name: 'other' }
    }
  }
  return { name: 'unknown' }
}

export function resolveAuthOutcome(
  identity: ToolAuditIdentity,
  cause: FailureCause | undefined,
): AuthOutcome {
  const deniedUpstream = cause === 'upstream_denied'
  switch (identity.kind) {
    case 'bearer':
      return deniedUpstream ? 'bearer_denied' : 'bearer_ok'
    case 'operator':
      return deniedUpstream ? 'operator_denied' : 'operator'
    case 'anonymous':
      // An anonymous call reaches upstream only on the deploy's shared token,
      // so a rejection there is the operator's credential failing.
      return deniedUpstream ? 'operator_denied' : 'anonymous'
  }
}

// Report an error raised outside a tool handler: routing, the MCP handler or
// the Node adapter. A client hanging up mid-request is not a server failure.
export function reportServerError(
  error: unknown,
  report: ServerErrorReport,
): void {
  const active = reporter
  if (!active) {
    return
  }
  try {
    const code = errorCodeTag(error)
    // Token verification talks to the OAuth issuer, so a reset there is an
    // upstream failure, not the caller leaving.
    if (report.source !== 'oauth_verify' && isClientDisconnect(error)) {
      active.addBreadcrumb({
        message: 'client disconnected',
        data: { source: report.source, ...(code ? { code } : {}) },
      })
      return
    }
    const client = resolveMcpClient(undefined, report.userAgent)
    active.capture(error, {
      fingerprint: [
        'socket-mcp',
        'server',
        report.source,
        errorTypeName(error),
      ],
      tags: {
        'auth.outcome': report.hasBearer ? 'bearer_ok' : 'unknown',
        'error.source': report.source,
        'mcp.client': client.name,
        ...(client.version ? { 'mcp.client_version': client.version } : {}),
        'mcp.tool': 'unknown',
        transport: 'http',
        ...(code ? { 'error.code': code } : {}),
      },
    })
  } catch {
    // Reporting never affects the request it describes.
  }
}

// Report one finished tool call. Successes are ignored; client-side outcomes
// leave a breadcrumb; real failures become one event grouped by tool, outcome,
// auth outcome and failure cause rather than by message text.
export function reportToolCall(report: ToolCallReport): void {
  const active = reporter
  if (!active || report.outcome === 'success') {
    return
  }
  try {
    const failure = report.result
      ? classifyToolFailure(report.result)
      : undefined
    const cause: FailureCause | undefined = report.threw
      ? 'thrown'
      : failure?.cause
    const auth = resolveAuthOutcome(report.identity, cause)
    if (!isReportableToolCall(report.outcome, cause, auth)) {
      active.addBreadcrumb({
        message: 'tool call',
        data: {
          'auth.outcome': auth,
          'mcp.tool': report.tool,
          'tool.outcome': report.outcome,
          ...(cause ? { 'failure.cause': cause } : {}),
        },
      })
      return
    }
    const error = report.threw ? report.error : failure?.error
    const client = resolveMcpClient(report.clientInfo, report.userAgent)
    const code = errorCodeTag(error)
    const status = failure?.status
    active.capture(error, {
      fingerprint: [
        'socket-mcp',
        'tool',
        report.tool,
        report.outcome,
        auth,
        cause ?? 'none',
      ],
      tags: {
        'auth.outcome': auth,
        'mcp.client': client.name,
        ...(client.version ? { 'mcp.client_version': client.version } : {}),
        'mcp.tool': report.tool,
        'tool.outcome': report.outcome,
        transport: report.transport,
        ...(cause ? { 'failure.cause': cause } : {}),
        ...(code ? { 'error.code': code } : {}),
        ...(status !== undefined && status >= 100 && status <= 599
          ? { 'upstream.status': String(status) }
          : {}),
      },
    })
  } catch {
    // Reporting never affects the tool call it describes.
  }
}

// Run one `tools/call` inside a Sentry transaction. Without reporting on, it
// just runs the call.
export function traceToolCall<T>(
  span: ToolCallSpan,
  run: () => Promise<T>,
  isError: () => boolean,
): Promise<T> {
  const active = reporter
  return active ? active.traceToolCall(span, run, isError) : run()
}

function isClientDisconnect(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const code = errorCode(error)
  return (
    error.name === 'AbortError' ||
    error.message === 'aborted' ||
    code === 'ECONNABORTED' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ERR_STREAM_PREMATURE_CLOSE'
  )
}

function normalizeClientName(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const name = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .slice(0, CLIENT_NAME_MAX_LENGTH)
    .replace(/^[-.]+|[-.]+$/gu, '')
  return name || undefined
}

function normalizeClientVersion(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d[\w.+-]{0,31}$/u.test(value)
    ? value
    : undefined
}
