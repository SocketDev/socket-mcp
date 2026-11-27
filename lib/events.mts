/**
 * @file MCP Events (SEP-3415, `io.modelcontextprotocol/events`, Beta) for the
 *   local stdio and `--http` server. Two event types, `socket.alert.created`
 *   and `socket.patch.available`, delivered by push only: `events/stream`
 *   polls the org alerts API with the caller's own token, asking only for
 *   alerts created (or, for patches, updated) since the previous poll, and
 *   emits each alert it has not emitted before.
 *   The TypeScript SDK has no events support yet
 *   (modelcontextprotocol/typescript-sdk#3209), so the two methods are plain
 *   custom request handlers. Swap them for the SDK's API once it lands.
 */
import { readFile } from 'node:fs/promises'
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
import { envInt, envString } from './env.mts'
import { logger } from './logger.mts'
import {
  AUTH_REQUIRED_MSG,
  resolveScopedAuthToken,
  SOCKET_API_BASE_URL,
} from './server.mts'
import { UpstreamHttpError } from './tool-outcome.mts'

export const EVENTS_EXTENSION = 'io.modelcontextprotocol/events'
export const ALERT_CREATED_EVENT = 'socket.alert.created'
export const PATCH_AVAILABLE_EVENT = 'socket.patch.available'

// Spec error codes (SEP-3415).
const NOT_FOUND = -32_023
const FORBIDDEN = -32_024

// Each poll looks back this far past the previous one, so an alert that is
// indexed a little after its timestamp is still found. Re-found alerts are
// deduped by id within a stream, and by eventId in the client after a resume.
export const POLL_OVERLAP_MS = 5 * 60 * 1000
// The API allows up to 5000 per page; a time-filtered poll rarely needs more
// than one page.
const PAGE_SIZE = 1000
// shortcut: stops after 20 pages (20,000 alerts) per poll and logs it; raise
// it if a single org can create more than that between two polls.
const MAX_PAGES = 20

const ARG_NAMES = ['org_slug', 'severity', 'repo_slug', 'package'] as const

const ALERT_INPUT_SCHEMA = {
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
    repo_slug: {
      type: 'string',
      description:
        'Comma-separated Socket repo slugs to watch, usually the repository name. Omit to watch every repo in the org',
    },
    package: {
      type: 'string',
      description: 'Only alerts for this package name, e.g. "minimist"',
    },
  },
  required: ['org_slug'],
  additionalProperties: false,
}

const ALERT_PAYLOAD_PROPERTIES = {
  org_slug: { type: 'string' },
  alert: {
    type: 'object',
    description: 'The alert as returned by GET /v0/orgs/{org}/alerts',
  },
}

const ALERT_CREATED_DEFINITION = {
  name: ALERT_CREATED_EVENT,
  description:
    'A new Socket alert appeared in an organization you can access, optionally limited to some repos, a package, or severities. Polls the org alerts API with your own token and fires once per new alert.',
  delivery: ['push'],
  inputSchema: ALERT_INPUT_SCHEMA,
  payloadSchema: {
    type: 'object',
    properties: ALERT_PAYLOAD_PROPERTIES,
    required: ['org_slug', 'alert'],
  },
}

const PATCH_AVAILABLE_DEFINITION = {
  name: PATCH_AVAILABLE_EVENT,
  description:
    'A Socket Certified Patch became available for a CVE alert in an organization you can access: a new alert that has one, or an existing alert that just gained one. A certified patch backports the fix into the exact version in use, so nothing is upgraded. Apply one with `socket-patch get <uuid>` from the project root. Fires once per alert.',
  delivery: ['push'],
  inputSchema: ALERT_INPUT_SCHEMA,
  payloadSchema: {
    type: 'object',
    properties: {
      ...ALERT_PAYLOAD_PROPERTIES,
      patches: {
        type: 'array',
        description: 'The certified patches available for this alert',
        items: {
          type: 'object',
          properties: {
            uuid: {
              type: 'string',
              description: 'Patch id, for `socket-patch get <uuid>`',
            },
            purl: { type: 'string', description: 'The patched package' },
          },
          required: ['uuid'],
        },
      },
    },
    required: ['org_slug', 'alert', 'patches'],
  },
}

const EVENT_DEFINITIONS = [ALERT_CREATED_DEFINITION, PATCH_AVAILABLE_DEFINITION]

export interface AlertCreatedArgs {
  org_slug: string
  severity?: string | undefined
  repo_slug?: string | undefined
  package?: string | undefined
}

// What a source fetches: the event's arguments, whether only alerts with an
// available certified patch count, and an optional time window (ISO 8601).
export type AlertQuery = AlertCreatedArgs & {
  patchOnly?: boolean | undefined
  createdSince?: string | undefined
  updatedSince?: string | undefined
}

interface StreamParams {
  name: string
  arguments: AlertCreatedArgs
  cursor: string | null
}

export type Alert = Record<string, unknown> & { id: string }

export type AlertSource = (
  query: AlertQuery,
  token: string,
  userAgent: string,
) => Promise<Alert[]>

export interface EventsOptions {
  // Poll interval for `events/stream`.
  pollMs?: number | undefined
  // Heartbeat interval, capped at the poll interval.
  heartbeatMs?: number | undefined
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
  const raw = isPlainObject(params['arguments']) ? params['arguments'] : {}
  const extra = Object.keys(raw).filter(
    key => !(ARG_NAMES as readonly string[]).includes(key),
  )
  if (extra.length > 0) {
    throw new Error(`unknown arguments: ${extra.join(', ')}`)
  }
  const args: Partial<Record<(typeof ARG_NAMES)[number], string>> = {}
  for (const key of ARG_NAMES) {
    const arg = raw[key]
    if (arg !== undefined && typeof arg !== 'string') {
      throw new Error(`arguments.${key} must be a string`)
    }
    if (arg) {
      args[key] = arg
    }
  }
  const orgSlug = args.org_slug
  if (!orgSlug) {
    throw new Error('arguments.org_slug must be a non-empty string')
  }
  const cursor = params['cursor']
  if (cursor !== undefined && cursor !== null) {
    if (typeof cursor !== 'string' || Number.isNaN(Date.parse(cursor))) {
      throw new Error('cursor must be a timestamp from this server, or null')
    }
  }
  return {
    name,
    arguments: { ...args, org_slug: orgSlug },
    cursor: cursor ?? null,
  }
}

function timeOf(alert: Alert, field: 'createdAt' | 'updatedAt'): string {
  const value = alert[field] ?? alert['createdAt']
  return typeof value === 'string' ? value : ''
}

// The API filters on "YYYY-MM-DD HH:MM:SS" in UTC.
function apiTime(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 19)
}

/**
 * Live source: open alerts for the org, matching the query, every page. A
 * time window keeps each poll small, because the endpoint's order is not by
 * time, so a single page could miss new alerts.
 */
export const socketAlertSource: AlertSource = async (
  query,
  token,
  userAgent,
) => {
  const alerts: Alert[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = await fetchAlerts({
      baseUrl: SOCKET_API_BASE_URL,
      orgSlug: query.org_slug,
      authToken: token,
      userAgent,
      filters: {
        status: 'open',
        perPage: PAGE_SIZE,
        ...(query.severity ? { severity: query.severity } : {}),
        ...(query.repo_slug ? { repoSlug: query.repo_slug } : {}),
        ...(query.package ? { artifactName: query.package } : {}),
        ...(query.patchOnly ? { patchStatus: 'patch_available' } : {}),
        ...(query.createdSince
          ? { createdAtGte: apiTime(query.createdSince) }
          : {}),
        ...(query.updatedSince
          ? { updatedAtGte: apiTime(query.updatedSince) }
          : {}),
        ...(cursor ? { cursor } : {}),
      },
    })
    const record = isPlainObject(body) ? body : {}
    const items = record['items'] ?? record['results'] ?? []
    alerts.push(...toAlerts(Array.isArray(items) ? items : []))
    const next = record['endCursor']
    if (typeof next !== 'string' || !next) {
      return alerts
    }
    cursor = next
  }
  logger.warn(
    { org: query.org_slug, pages: MAX_PAGES },
    'alerts poll stopped at the page limit',
  )
  return alerts
}

// Keep objects that carry an `id` (or `key`), with the id as a string.
function toAlerts(items: unknown[]): Alert[] {
  return items.flatMap(item => {
    if (!isPlainObject(item)) {
      return []
    }
    const id = item['id'] ?? item['key']
    return typeof id === 'string' || typeof id === 'number'
      ? [{ ...item, id: String(id) }]
      : []
  })
}

function alertLocations(alert: Alert): Array<Record<string, unknown>> {
  const locations = Array.isArray(alert['locations']) ? alert['locations'] : []
  return locations.filter(isPlainObject)
}

/**
 * The certified patches an alert can use: its locations whose patch status is
 * `patch_available`, one entry per patch uuid.
 */
export function availablePatches(
  alert: Alert,
): Array<{ uuid: string; purl?: string }> {
  const patches = new Map<string, { uuid: string; purl?: string }>()
  for (const location of alertLocations(alert)) {
    if (!isPlainObject(location['patch'])) {
      continue
    }
    const { uuid, status } = location['patch']
    if (typeof uuid !== 'string' || status !== 'patch_available') {
      continue
    }
    const artifact = isPlainObject(location['artifact'])
      ? location['artifact']
      : {}
    const { type, namespace, name, version } = artifact
    const purl =
      typeof type === 'string' && typeof name === 'string'
        ? `pkg:${type}/${typeof namespace === 'string' && namespace ? `${namespace}/` : ''}${name}${typeof version === 'string' ? `@${version}` : ''}`
        : undefined
    patches.set(uuid, { uuid, ...(purl ? { purl } : {}) })
  }
  return [...patches.values()]
}

// The same filters the API applies, for alerts from the demo file.
function matchesQuery(alert: Alert, query: AlertQuery): boolean {
  const list = (value: string | undefined) =>
    value?.split(',').map(item => item.trim())
  const severities = list(query.severity)
  if (severities && !severities.includes(String(alert['severity'] ?? ''))) {
    return false
  }
  const locations = alertLocations(alert)
  const repos = list(query.repo_slug)
  if (
    repos &&
    !locations.some(location => {
      const repo = isPlainObject(location['repository'])
        ? location['repository']['slug']
        : undefined
      return typeof repo === 'string' && repos.includes(repo)
    })
  ) {
    return false
  }
  if (
    query.package &&
    !locations.some(
      location =>
        isPlainObject(location['artifact']) &&
        location['artifact']['name'] === query.package,
    )
  ) {
    return false
  }
  if (query.patchOnly && availablePatches(alert).length === 0) {
    return false
  }
  if (query.createdSince && timeOf(alert, 'createdAt') < query.createdSince) {
    return false
  }
  if (query.updatedSince && timeOf(alert, 'updatedAt') < query.updatedSince) {
    return false
  }
  return true
}

/**
 * Demo source (SOCKET_MCP_EVENTS_FAKE_ALERTS_FILE): no network and no token.
 * Each poll reads alerts from a local NDJSON file, one alert object per line,
 * and applies the same filters as the API. Give each line a current
 * `createdAt` so it counts as new.
 */
export function fileAlertSource(file: string): AlertSource {
  return async query => {
    let text = ''
    try {
      text = await readFile(file, 'utf8')
    } catch {
      // No file yet means no alerts yet.
    }
    const parsed = text.split('\n').flatMap(line => {
      try {
        return line.trim() ? [JSON.parse(line) as unknown] : []
      } catch {
        return []
      }
    })
    return toAlerts(parsed).filter(alert => matchesQuery(alert, query))
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
  // Clients drop a quiet stream fast (OpenCode 2.4 after 30s, whatever we
  // grant), so heartbeats run on their own short clock, not the poll's.
  const heartbeatMs = Math.min(
    pollMs,
    options.heartbeatMs ?? envInt('SOCKET_MCP_EVENTS_HEARTBEAT_MS') ?? 10_000,
  )
  const fakeFile = envString('SOCKET_MCP_EVENTS_FAKE_ALERTS_FILE')
  const fake = fakeFile !== undefined
  const source =
    options.source ?? (fake ? fileAlertSource(fakeFile) : socketAlertSource)
  const userAgent = options.userAgent ?? ''

  server.registerCapabilities({ extensions: { [EVENTS_EXTENSION]: {} } })

  server.setRequestHandler(
    'events/list',
    { params: passthrough(value => value) },
    () => ({ events: EVENT_DEFINITIONS }),
  )

  server.setRequestHandler(
    'events/stream',
    { params: passthrough(parseStreamParams) },
    async (params, ctx) => {
      if (!EVENT_DEFINITIONS.some(event => event.name === params.name)) {
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
        heartbeatMs,
        poll: query => source(query, token ?? '', userAgent),
      })
    },
  )
}

/**
 * Run one push subscription until the client cancels it.
 *
 * - `socket.alert.created` asks for alerts created since the previous poll (minus
 *   the overlap) and never emits one created before the stream started, unless
 *   the client resumed from a cursor.
 * - `socket.patch.available` first fetches every currently patchable alert as the
 *   baseline, then asks for patchable alerts updated since the previous poll,
 *   which also catches an existing alert that just gained a patch.
 *
 * The cursor is the start time of the last completed poll. A resume replays
 * from the cursor minus the overlap, so delivery is at least once, and the
 * client dedupes on `eventId`.
 */
export async function streamAlerts(
  params: StreamParams,
  ctx: ServerContext,
  opts: {
    pollMs: number
    heartbeatMs: number
    poll: (query: AlertQuery) => Promise<Alert[]>
  },
): Promise<{ _meta: Record<string, unknown> }> {
  const { signal } = ctx.mcpReq
  const meta = { [SUBSCRIPTION_ID_META_KEY]: ctx.mcpReq.id }
  const notify = (method: string, body: Record<string, unknown>) =>
    ctx.mcpReq.notify({
      method: `notifications/events/${method}`,
      params: { ...body, _meta: meta },
    })
  const patchEvent = params.name === PATCH_AVAILABLE_EVENT
  const timeField = patchEvent ? 'updatedAt' : 'createdAt'
  const startedAt = new Date().toISOString()
  const resumed = params.cursor !== null
  let cursor = params.cursor ?? startedAt
  let needsBaseline = patchEvent && !resumed
  const seen = new Set<string>()

  const tick = async (): Promise<boolean> => {
    const pollStart = new Date().toISOString()
    const since = new Date(Date.parse(cursor) - POLL_OVERLAP_MS).toISOString()
    const window = needsBaseline
      ? {}
      : patchEvent
        ? { updatedSince: since }
        : { createdSince: since }
    let alerts: Alert[]
    try {
      alerts = await opts.poll({
        ...params.arguments,
        patchOnly: patchEvent,
        ...window,
      })
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
    const ordered = alerts.toSorted((a, b) =>
      timeOf(a, timeField).localeCompare(timeOf(b, timeField)),
    )
    for (const alert of ordered) {
      // Checked per alert: one poll can return the same id twice, for
      // example when results shift between pages.
      if (seen.has(alert.id)) {
        continue
      }
      seen.add(alert.id)
      if (needsBaseline) {
        continue
      }
      // The overlap window reaches back before the stream started; those
      // alerts already existed when the user subscribed.
      if (!resumed && !patchEvent && timeOf(alert, 'createdAt') <= startedAt) {
        continue
      }
      await notify('event', {
        eventId: `${params.arguments.org_slug}:${alert.id}`,
        name: params.name,
        timestamp: timeOf(alert, timeField) || pollStart,
        data: {
          org_slug: params.arguments.org_slug,
          alert,
          ...(patchEvent ? { patches: availablePatches(alert) } : {}),
        },
        cursor,
      })
    }
    needsBaseline = false
    cursor = pollStart
    await notify('heartbeat', { cursor })
    return true
  }

  logger.info({ event: params.name }, 'events stream opened')
  await notify('active', {
    cursor,
    truncated: false,
    heartbeatMs: opts.heartbeatMs,
  })
  let open = await tick()
  let lastPoll = Date.now()
  while (open && !signal.aborted) {
    const untilPoll = Math.max(0, lastPoll + opts.pollMs - Date.now())
    try {
      await sleep(Math.min(opts.heartbeatMs, untilPoll), undefined, { signal })
    } catch {
      break
    }
    if (Date.now() >= lastPoll + opts.pollMs) {
      lastPoll = Date.now()
      open = await tick()
    } else {
      await notify('heartbeat', { cursor })
    }
  }
  logger.info({ event: params.name }, 'events stream closed')
  return { _meta: meta }
}
