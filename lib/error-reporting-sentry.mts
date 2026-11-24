/**
 * @file The Sentry client behind error reporting. `error-reporting.mts` loads
 *   this module with a dynamic import, and only when SOCKET_MCP_SENTRY_DSN is
 *   set in HTTP mode. The client comes from `@sentry/core` alone: no
 *   OpenTelemetry, no module patching, no default integrations and no
 *   tracing. Envelopes go out through the global `fetch`.
 *   Every event is rebuilt from an allowlist in `beforeSend`, so nothing the
 *   SDK or an error happens to carry leaves the process unless it is named
 *   here. Exception messages are replaced with a summary built from the
 *   bounded tags, because upstream errors embed request URLs (org slugs,
 *   package names, query strings) and response bodies. Stack frames keep
 *   their function, file basename and position. Request data, users, extra
 *   context and the host name are dropped.
 */

import process from 'node:process'

import {
  createStackParser,
  createTransport,
  linkedErrorsIntegration,
  Scope,
} from '@sentry/core'
import type {
  BaseTransportOptions,
  Breadcrumb,
  ErrorEvent,
  Exception,
  StackFrame,
  Transport,
} from '@sentry/core'
import { nodeStackLineParser, ServerRuntimeClient } from '@sentry/core/server'

import type { ErrorReporter } from './error-reporting.mts'

export interface SentryReporterOptions {
  readonly dsn: string
  readonly environment?: string | undefined
  readonly makeTransport?:
    | ((options: BaseTransportOptions) => Transport)
    | undefined
  readonly release: string
}

// Tags an event may carry. Values are re-checked against TAG_VALUE_PATTERN.
export const ALLOWED_TAG_KEYS: ReadonlySet<string> = new Set([
  'auth.outcome',
  'error.code',
  'error.source',
  'failure.cause',
  'mcp.client',
  'mcp.client_version',
  'mcp.tool',
  'tool.outcome',
  'transport',
  'upstream.status',
])

const MAX_BREADCRUMBS = 20
const REDACTED = '[redacted]'
const TAG_VALUE_PATTERN = /^[\w.:+-]{1,64}$/u
const TRANSPORT_TIMEOUT_MS = 5000

/**
 * Build a reporter, or answer undefined when the DSN does not parse. The
 * client and its scope are private to the reporter rather than installed as
 * Sentry's global client.
 */
export function createSentryReporter(
  options: SentryReporterOptions,
): ErrorReporter | undefined {
  // The SDK prints a DSN it cannot parse to the console, so a malformed one
  // is turned away here first.
  if (!isPlausibleDsn(options.dsn)) {
    return undefined
  }
  const client = new ServerRuntimeClient({
    dsn: options.dsn,
    ...(options.environment ? { environment: options.environment } : {}),
    release: options.release,
    transport: options.makeTransport ?? makeFetchTransport,
    stackParser: createStackParser(nodeStackLineParser()),
    integrations: [linkedErrorsIntegration({ limit: 3 })],
    beforeSend: event => sanitizeEvent(event),
    // Errors only: no span streaming, no request, header, cookie, body or
    // variable capture.
    traceLifecycle: 'static',
    dataCollection: {
      cookies: false,
      databaseQueryData: false,
      frameContextLines: 0,
      genAI: { inputs: false, outputs: false },
      graphQL: { document: false, variables: false },
      httpBodies: [],
      httpHeaders: false,
      mcp: { inputs: false, outputs: false },
      queues: false,
      stackFrameVariables: false,
      urlQueryParams: false,
      userInfo: false,
    },
    maxBreadcrumbs: MAX_BREADCRUMBS,
    sendClientReports: false,
    platform: 'node',
    runtime: { name: 'node', version: process.version },
  })
  if (!client.getDsn()) {
    return undefined
  }
  const scope = new Scope()
  scope.setClient(client)
  client.init()
  return {
    addBreadcrumb(breadcrumb) {
      scope.addBreadcrumb(
        {
          category: 'mcp',
          level: 'info',
          message: breadcrumb.message,
          data: { ...breadcrumb.data },
        },
        MAX_BREADCRUMBS,
      )
    },
    capture(error, context) {
      const eventScope = scope.clone()
      eventScope.setLevel('error')
      eventScope.setTags({ ...context.tags })
      eventScope.setFingerprint([...context.fingerprint])
      eventScope.captureException(error ?? new Error(REDACTED), {
        mechanism: { type: 'socket-mcp', handled: true },
      })
    },
    close: timeoutMs => client.close(timeoutMs),
    flush: timeoutMs => client.flush(timeoutMs),
  }
}

// Post each envelope with the global `fetch`. A request that hangs past five
// seconds is aborted; the SDK records the loss and the server carries on.
export function makeFetchTransport(options: BaseTransportOptions): Transport {
  return createTransport(options, async request => {
    const response = await fetch(options.url, {
      method: 'POST',
      body: request.body,
      ...(options.headers ? { headers: options.headers } : {}),
      signal: AbortSignal.timeout(TRANSPORT_TIMEOUT_MS),
    })
    await response.body?.cancel().catch(() => {})
    return {
      statusCode: response.status,
      headers: {
        'retry-after': response.headers.get('retry-after'),
        'x-sentry-rate-limits': response.headers.get('x-sentry-rate-limits'),
      },
    }
  })
}

/**
 * Rebuild an event from the fields error reporting means to send: ids,
 * level, release and environment, the SDK name, allowlisted tags, the
 * fingerprint, exception types with message-free stack frames, our own
 * breadcrumbs and the Node version. Everything else is dropped.
 */
export function sanitizeEvent(event: ErrorEvent): ErrorEvent {
  const tags = sanitizeTags(event.tags)
  const values = event.exception?.values ?? []
  const lastIndex = values.length - 1
  const safe: ErrorEvent = {
    type: undefined,
    contexts: { runtime: { name: 'node', version: process.version } },
    exception: {
      values: values.map((value, index) =>
        // Sentry lists causes first and the reported error last; only the
        // last one gets the readable summary.
        sanitizeException(
          value,
          index === lastIndex ? summarize(tags) : REDACTED,
        ),
      ),
    },
    tags,
  }
  if (event.event_id) {
    safe.event_id = event.event_id
  }
  if (event.timestamp !== undefined) {
    safe.timestamp = event.timestamp
  }
  if (event.level) {
    safe.level = event.level
  }
  if (event.platform) {
    safe.platform = event.platform
  }
  const release = boundedTagValue(event.release)
  if (release) {
    safe.release = release
  }
  const environment = boundedTagValue(event.environment)
  if (environment) {
    safe.environment = environment
  }
  if (event.sdk?.name && event.sdk.version) {
    safe.sdk = { name: event.sdk.name, version: event.sdk.version }
  }
  const fingerprint = event.fingerprint
    ?.map(boundedTagValue)
    .filter(part => part !== undefined)
  if (fingerprint?.length) {
    safe.fingerprint = fingerprint
  }
  const breadcrumbs = event.breadcrumbs
    ?.filter(breadcrumb => breadcrumb.category === 'mcp')
    .map(sanitizeBreadcrumb)
  if (breadcrumbs?.length) {
    safe.breadcrumbs = breadcrumbs
  }
  return safe
}

// An http(s) URL with a public key and a numeric project id, the shape the
// SDK accepts.
export function isPlausibleDsn(dsn: string): boolean {
  try {
    const url = new URL(dsn)
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.username !== '' &&
      /\/\d+$/u.test(url.pathname)
    )
  } catch {
    return false
  }
}

function boundedTagValue(value: unknown): string | undefined {
  const text = typeof value === 'number' ? String(value) : value
  return typeof text === 'string' && TAG_VALUE_PATTERN.test(text)
    ? text
    : undefined
}

function sanitizeBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  const data: Record<string, string> = {}
  for (const [key, value] of Object.entries(breadcrumb.data ?? {})) {
    const safeValue = boundedTagValue(value)
    if (/^[\w.]{1,32}$/u.test(key) && safeValue) {
      data[key] = safeValue
    }
  }
  return {
    category: 'mcp',
    ...(breadcrumb.level ? { level: breadcrumb.level } : {}),
    ...(breadcrumb.timestamp !== undefined
      ? { timestamp: breadcrumb.timestamp }
      : {}),
    message: boundedMessage(breadcrumb.message),
    data,
  }
}

function boundedMessage(value: unknown): string {
  return typeof value === 'string' && /^[\w .:-]{1,64}$/u.test(value)
    ? value
    : REDACTED
}

function sanitizeException(value: Exception, summary: string): Exception {
  const type =
    typeof value.type === 'string' &&
    /^[A-Za-z_$][\w$]{0,63}$/u.test(value.type)
      ? value.type
      : 'Error'
  const safe: Exception = { type, value: summary }
  if (value.mechanism) {
    const { exception_id, handled, parent_id, source } = value.mechanism
    safe.mechanism = {
      type: boundedTagValue(value.mechanism.type) ?? 'generic',
      ...(handled !== undefined ? { handled } : {}),
      ...(exception_id !== undefined ? { exception_id } : {}),
      ...(parent_id !== undefined ? { parent_id } : {}),
      ...(typeof source === 'string' && /^[\w.[\]]{1,32}$/u.test(source)
        ? { source }
        : {}),
    }
  }
  const frames = value.stacktrace?.frames
  if (frames?.length) {
    safe.stacktrace = { frames: frames.map(sanitizeFrame) }
  }
  return safe
}

// Keep where a frame ran, never what it held: function name, file basename,
// line, column and the in-app flag.
function sanitizeFrame(frame: StackFrame): StackFrame {
  const safe: StackFrame = {}
  if (
    typeof frame.function === 'string' &&
    /^[\w$.<>[\] -]{1,128}$/u.test(frame.function)
  ) {
    safe.function = frame.function
  }
  const filename = safeFilename(frame.filename)
  if (filename) {
    safe.filename = filename
  }
  if (frame.lineno !== undefined) {
    safe.lineno = frame.lineno
  }
  if (frame.colno !== undefined) {
    safe.colno = frame.colno
  }
  if (frame.in_app !== undefined) {
    safe.in_app = frame.in_app
  }
  return safe
}

function safeFilename(filename: string | undefined): string | undefined {
  if (!filename) {
    return undefined
  }
  if (/^node:[\w/.-]{1,120}$/u.test(filename)) {
    return filename
  }
  // A basename, so no install path (and no user's home directory) is sent.
  const base = filename.split(/[/\\]/u).pop()
  return base && /^[\w.-]{1,128}$/u.test(base) ? base : undefined
}

function sanitizeTags(tags: ErrorEvent['tags']): Record<string, string> {
  const safe: Record<string, string> = {}
  for (const [key, value] of Object.entries(tags ?? {})) {
    const safeValue = boundedTagValue(value)
    if (ALLOWED_TAG_KEYS.has(key) && safeValue) {
      safe[key] = safeValue
    }
  }
  return safe
}

// A readable event title from bounded tags alone, e.g. `alerts upstream_5xx
// 502` or `mcp_handler`.
function summarize(tags: Readonly<Record<string, string>>): string {
  const parts =
    tags['error.source'] !== undefined
      ? [tags['error.source']]
      : [tags['mcp.tool'], tags['failure.cause'] ?? tags['tool.outcome']]
  parts.push(tags['upstream.status'], tags['error.code'])
  const summary = parts.filter(part => part !== undefined).join(' ')
  return summary || REDACTED
}
