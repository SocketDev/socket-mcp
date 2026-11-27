/**
 * @file MCP Events (SEP-3415, `io.modelcontextprotocol/events`, Beta) for the
 *   local stdio and `--http` server. One event type, `socket.alert.created`,
 *   delivered by push only: `events/stream` polls the org alerts API with the
 *   caller's own token and emits each alert it has not seen before.
 *   The TypeScript SDK has no events support yet
 *   (modelcontextprotocol/typescript-sdk#3209), so the two methods are plain
 *   custom request handlers. Swap them for the SDK's API once it lands.
 */
import { setTimeout as sleep } from 'node:timers/promises'

import {
  ProtocolError,
  SUBSCRIPTION_ID_META_KEY,
} from '@modelcontextprotocol/server'
import type {
  Server,
  ServerContext,
  StandardSchemaV1,
} from '@modelcontextprotocol/server'
import { isPlainObject } from '@socketsecurity/lib-stable/objects/predicates'

import { fetchAlerts } from './alerts.mts'
import { envBool, envInt } from './env.mts'
import { logger } from './logger.mts'
import {
  AUTH_REQUIRED_MSG,
  resolveScopedAuthToken,
  SOCKET_API_BASE_URL,
} from './server.mts'
import { UpstreamHttpError } from './tool-outcome.mts'

export const EVENTS_EXTENSION = 'io.modelcontextprotocol/events'
export const ALERT_CREATED_EVENT = 'socket.alert.created'

// Spec error codes (SEP-3415).
const NOT_FOUND = -32_023
const FORBIDDEN = -32_024

const ALERT_CREATED_DEFINITION = {
  name: ALERT_CREATED_EVENT,
  description:
    'A new Socket alert appeared for an organization you can access. Polls the org alerts API with your own token and fires once per new alert.',
  delivery: ['push'],
  inputSchema: {
    type: 'object',
    properties: {
      org_slug: {
        type: 'string',
        description: 'Organization slug, e.g. "my-org"',
      },
      severity: {
        type: 'string',
        description:
          'Comma-separated severities to include: subset of low,medium,high,critical',
      },
    },
    required: ['org_slug'],
    additionalProperties: false,
  },
  payloadSchema: {
    type: 'object',
    properties: {
      org_slug: { type: 'string' },
      alert: {
        type: 'object',
        description: 'The alert as returned by GET /v0/orgs/{org}/alerts',
      },
    },
    required: ['org_slug', 'alert'],
  },
}

export interface AlertCreatedArgs {
  org_slug: string
  severity?: string | undefined
}

interface StreamParams {
  name: string
  arguments: AlertCreatedArgs
  cursor: string | null
}

export type Alert = Record<string, unknown> & { id: string }

export type AlertSource = (
  args: AlertCreatedArgs,
  token: string,
  userAgent: string,
) => Promise<Alert[]>

export interface EventsOptions {
  // Poll interval for `events/stream`; also the granted heartbeat interval.
  pollMs?: number | undefined
  source?: AlertSource | undefined
  userAgent?: string | undefined
}

// Pass-through Standard Schema: the SDK only needs a validator object for a
// custom method, and these params are checked by hand below.
function passthrough<T>(
  parse: (value: unknown) => T,
): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'socket-mcp',
      validate(value) {
        try {
          return { value: parse(value) }
        } catch (error) {
          return { issues: [{ message: (error as Error).message }] }
        }
      },
    },
  }
}

export function parseStreamParams(value: unknown): StreamParams {
  const params = isPlainObject(value) ? value : {}
  const name = params['name']
  if (typeof name !== 'string') {
    throw new Error('name must be a string')
  }
  const args = isPlainObject(params['arguments']) ? params['arguments'] : {}
  const orgSlug = args['org_slug']
  const severity = args['severity']
  if (typeof orgSlug !== 'string' || orgSlug === '') {
    throw new Error('arguments.org_slug must be a non-empty string')
  }
  if (severity !== undefined && typeof severity !== 'string') {
    throw new Error('arguments.severity must be a string')
  }
  const extra = Object.keys(args).filter(
    key => key !== 'org_slug' && key !== 'severity',
  )
  if (extra.length > 0) {
    throw new Error(`unknown arguments: ${extra.join(', ')}`)
  }
  const cursor = params['cursor']
  if (cursor !== undefined && cursor !== null && typeof cursor !== 'string') {
    throw new Error('cursor must be a string or null')
  }
  return {
    name,
    arguments: { org_slug: orgSlug, ...(severity ? { severity } : {}) },
    cursor: cursor ?? null,
  }
}

function alertTime(alert: Alert): string | undefined {
  const value = alert['createdAt'] ?? alert['created_at']
  return typeof value === 'string' ? value : undefined
}

// Live source: open alerts for the org, newest page only.
// shortcut: reads one page of 100, so a burst of >100 alerts between polls
// drops the overflow; page through `endCursor` if that matters.
export const socketAlertSource: AlertSource = async (
  args,
  token,
  userAgent,
) => {
  const body = await fetchAlerts({
    baseUrl: SOCKET_API_BASE_URL,
    orgSlug: args.org_slug,
    authToken: token,
    userAgent,
    filters: {
      status: 'open',
      perPage: 100,
      ...(args.severity ? { severity: args.severity } : {}),
    },
  })
  const record = isPlainObject(body) ? body : {}
  const items = record['items'] ?? record['results'] ?? []
  return (Array.isArray(items) ? items : []).flatMap(item => {
    if (!isPlainObject(item)) {
      return []
    }
    const id = item['id'] ?? item['key']
    return typeof id === 'string' || typeof id === 'number'
      ? [{ ...item, id: String(id) }]
      : []
  })
}

// Demo source (SOCKET_MCP_EVENTS_FAKE_ALERT=1): no network. The first poll is
// empty (the baseline); every later poll returns one more synthetic alert, so
// a new event fires once per poll interval.
export function fakeAlertSource(): AlertSource {
  const alerts: Alert[] = []
  let polls = 0
  return async args => {
    if (polls++ > 0) {
      const severity = args.severity?.split(',')[0]?.trim() || 'critical'
      alerts.unshift({
        id: `fake-alert-${polls - 1}`,
        type: 'malware',
        severity,
        category: 'supplyChainRisk',
        status: 'open',
        createdAt: new Date().toISOString(),
        artifact: { type: 'npm', name: 'demo-evil-package', version: '6.6.6' },
        description: 'Synthetic alert from SOCKET_MCP_EVENTS_FAKE_ALERT',
      })
    }
    return alerts
  }
}

/**
 * Advertise the extension and register `events/list` and `events/stream` on
 * a configured server. The capability rides on both `initialize` and
 * `server/discover`, since the SDK reads both from `getCapabilities()`.
 */
export function registerEventHandlers(
  server: Server,
  options: EventsOptions = {},
): void {
  const pollMs = options.pollMs ?? envInt('SOCKET_MCP_EVENTS_POLL_MS') ?? 60_000
  const fake = envBool('SOCKET_MCP_EVENTS_FAKE_ALERT')
  const source =
    options.source ?? (fake ? fakeAlertSource() : socketAlertSource)
  const userAgent = options.userAgent ?? ''

  server.registerCapabilities({ extensions: { [EVENTS_EXTENSION]: {} } })

  server.setRequestHandler(
    'events/list',
    { params: passthrough(value => value) },
    () => ({ events: [ALERT_CREATED_DEFINITION] }),
  )

  server.setRequestHandler(
    'events/stream',
    { params: passthrough(parseStreamParams) },
    async (params, ctx) => {
      if (params.name !== ALERT_CREATED_EVENT) {
        throw new ProtocolError(NOT_FOUND, `Unknown event: ${params.name}`, {
          kind: 'event',
        })
      }
      const token = resolveScopedAuthToken(ctx.http?.authInfo?.token)
      if (!token && !fake) {
        throw new ProtocolError(FORBIDDEN, AUTH_REQUIRED_MSG)
      }
      return streamAlerts(params, ctx, {
        pollMs,
        poll: () => source(params.arguments, token ?? '', userAgent),
      })
    },
  )
}

/**
 * Run one push subscription until the client cancels it. Dedup is by alert
 * id within the stream; the cursor is the newest `createdAt` emitted, so a
 * reconnect with it skips everything at or before that time.
 */
export async function streamAlerts(
  params: StreamParams,
  ctx: ServerContext,
  opts: { pollMs: number; poll: () => Promise<Alert[]> },
): Promise<{ _meta: Record<string, unknown> }> {
  const { signal } = ctx.mcpReq
  const meta = { [SUBSCRIPTION_ID_META_KEY]: ctx.mcpReq.id }
  const notify = (method: string, body: Record<string, unknown>) =>
    ctx.mcpReq.notify({
      method: `notifications/events/${method}`,
      params: { ...body, _meta: meta },
    })
  const seen = new Set<string>()
  // With no client cursor, whatever the first poll returns is the baseline.
  const resumed = params.cursor !== null
  let cursor = params.cursor ?? new Date().toISOString()
  let baseline = true

  const tick = async (): Promise<boolean> => {
    let alerts: Alert[]
    try {
      alerts = await opts.poll()
    } catch (error) {
      const status = error instanceof UpstreamHttpError ? error.status : 0
      const payload = {
        error: {
          code: status === 401 || status === 403 ? FORBIDDEN : -32_603,
          message: 'UpstreamError',
          data: { reason: (error as Error).message },
        },
      }
      if (status === 401 || status === 403) {
        await notify('terminated', payload)
        return false
      }
      await notify('error', payload)
      return true
    }
    // Oldest first, so the cursor only moves forward.
    const fresh = alerts.filter(alert => !seen.has(alert.id)).reverse()
    for (const alert of fresh) {
      seen.add(alert.id)
      const time = alertTime(alert)
      // On the first poll emit only what is newer than the client's cursor.
      if (baseline && (!resumed || !time || time <= cursor)) {
        continue
      }
      if (time && time > cursor) {
        cursor = time
      }
      await notify('event', {
        eventId: `${params.arguments.org_slug}:${alert.id}`,
        name: ALERT_CREATED_EVENT,
        timestamp: time ?? new Date().toISOString(),
        data: { org_slug: params.arguments.org_slug, alert },
        cursor,
      })
    }
    if (baseline) {
      baseline = false
    } else if (fresh.length === 0) {
      await notify('heartbeat', { cursor })
    }
    return true
  }

  logger.info({ event: ALERT_CREATED_EVENT }, 'events stream opened')
  await notify('active', {
    cursor,
    truncated: false,
    heartbeatMs: opts.pollMs,
  })
  let open = await tick()
  while (open && !signal.aborted) {
    try {
      await sleep(opts.pollMs, undefined, { signal })
    } catch {
      break
    }
    open = await tick()
  }
  logger.info({ event: ALERT_CREATED_EVENT }, 'events stream closed')
  return { _meta: meta }
}
