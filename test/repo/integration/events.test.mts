import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import type { StandardSchemaV1 } from '@modelcontextprotocol/client'
import nock from 'nock'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import {
  ALERT_CREATED_EVENT,
  EVENTS_EXTENSION,
  PATCH_AVAILABLE_EVENT,
} from '../../../lib/events.mts'
import {
  createConfiguredServer,
  setStaticApiKey,
} from '../../../lib/server.mts'

const API = 'https://api.socket.dev'

const anything: StandardSchemaV1<unknown, Record<string, unknown>> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: value => ({ value: value as Record<string, unknown> }),
  },
}

interface Note {
  method: string
  params: Record<string, unknown>
}

async function connect(): Promise<{ client: Client; notes: Note[] }> {
  const server = createConfiguredServer(undefined, 'stdio')
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client(
    { name: 'test', version: '0.0.0' },
    { capabilities: {} },
  )
  await client.connect(clientTransport)
  const notes: Note[] = []
  for (const kind of ['active', 'event', 'heartbeat', 'error', 'terminated']) {
    const method = `notifications/events/${kind}`
    client.setNotificationHandler(method, { params: anything }, params => {
      notes.push({ method, params })
    })
  }
  return { client, notes }
}

function openStream(
  client: Client,
  args: Record<string, unknown>,
  name = ALERT_CREATED_EVENT,
) {
  const controller = new AbortController()
  const done = client
    .request(
      {
        method: 'events/stream',
        params: { name, arguments: args, cursor: null },
      },
      anything,
      { signal: controller.signal, timeout: 60_000 },
    )
    .catch((error: unknown) => error)
  return { controller, done }
}

const alert = (id: string, createdAt: string) => ({
  id,
  type: 'malware',
  severity: 'critical',
  createdAt,
})

beforeEach(() => {
  nock.disableNetConnect()
  process.env['SOCKET_MCP_EVENTS_POLL_MS'] = '20'
  setStaticApiKey('tok')
})

afterEach(() => {
  nock.cleanAll()
  nock.enableNetConnect()
  delete process.env['SOCKET_MCP_EVENTS_POLL_MS']
  delete process.env['SOCKET_MCP_EVENTS_FAKE_ALERTS_FILE']
  delete process.env['SOCKET_MCP_EVENTS_HEARTBEAT_MS']
  setStaticApiKey('')
})

test('advertises the events extension and lists socket.alert.created', async () => {
  const { client } = await connect()
  expect(client.getServerCapabilities()?.extensions).toMatchObject({
    [EVENTS_EXTENSION]: {},
  })
  const result = await client.request(
    { method: 'events/list', params: {} },
    anything,
  )
  const events = result['events'] as Array<Record<string, unknown>>
  expect(events.map(e => e['name'])).toEqual([
    ALERT_CREATED_EVENT,
    PATCH_AVAILABLE_EVENT,
  ])
  expect(events[0]).toMatchObject({
    name: ALERT_CREATED_EVENT,
    delivery: ['push'],
    inputSchema: { required: ['org_slug'] },
  })
  await client.close()
})

test('events/stream emits a new alert exactly once', async () => {
  const old = alert('a1', '2026-11-01T00:00:00.000Z')
  const fresh = alert('a2', '2026-11-02T00:00:00.000Z')
  const scope = nock(API)
    .matchHeader('authorization', 'Bearer tok')
    .get('/v0/orgs/my-org/alerts')
    .query({
      'filters.alertStatus': 'open',
      'filters.alertSeverity': 'critical',
      per_page: '100',
    })
    .reply(200, { items: [old] })
    .get('/v0/orgs/my-org/alerts')
    .query(true)
    .times(3)
    .reply(200, { items: [fresh, old] })

  const { client, notes } = await connect()
  const { controller, done } = openStream(client, {
    org_slug: 'my-org',
    severity: 'critical',
  })
  await vi.waitFor(() => expect(scope.isDone()).toBe(true), { timeout: 5000 })
  controller.abort()
  await done

  const events = notes.filter(n => n.method === 'notifications/events/event')
  expect(notes[0]?.method).toBe('notifications/events/active')
  expect(events).toHaveLength(1)
  expect(events[0]?.params).toMatchObject({
    eventId: 'my-org:a2',
    name: ALERT_CREATED_EVENT,
    cursor: expect.any(String),
    data: { org_slug: 'my-org', alert: { id: 'a2' } },
  })
  expect(notes.some(n => n.method === 'notifications/events/heartbeat')).toBe(
    true,
  )
  await client.close()
})

test('events/stream rejects an unknown event name', async () => {
  const { client } = await connect()
  const { done } = openStream(client, { org_slug: 'my-org' }, 'nope')
  expect(await done).toMatchObject({ code: -32_023 })
  await client.close()
})

test('fake-alerts file fires each appended alert once, with no API call', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcp-events-'))
  const file = path.join(dir, 'alerts.ndjson')
  const line = (id: string, severity = 'critical') =>
    `${JSON.stringify({ id, severity, createdAt: new Date().toISOString() })}\n`
  writeFileSync(file, line('old'))
  process.env['SOCKET_MCP_EVENTS_FAKE_ALERTS_FILE'] = file
  setStaticApiKey('')
  const { client, notes } = await connect()
  const events = () =>
    notes.filter(n => n.method === 'notifications/events/event')
  const { controller, done } = openStream(client, {
    org_slug: 'demo',
    severity: 'critical,high',
  })
  await vi.waitFor(() => expect(notes.length).toBeGreaterThan(1))
  appendFileSync(file, line('low-one', 'low') + 'not json\n' + line('new'))
  await vi.waitFor(() => expect(events()).toHaveLength(1), { timeout: 5000 })
  appendFileSync(file, line('new'))
  const heartbeats = notes.length
  await vi.waitFor(() => expect(notes.length).toBeGreaterThan(heartbeats + 2))
  controller.abort()
  await done
  expect(events().map(n => n.params['eventId'])).toEqual(['demo:new'])
  await client.close()
  rmSync(dir, { recursive: true, force: true })
})

test('events/stream heartbeats between slow polls', async () => {
  process.env['SOCKET_MCP_EVENTS_POLL_MS'] = '60000'
  process.env['SOCKET_MCP_EVENTS_HEARTBEAT_MS'] = '20'
  nock(API).get('/v0/orgs/my-org/alerts').query(true).reply(200, { items: [] })
  const { client, notes } = await connect()
  const { controller, done } = openStream(client, { org_slug: 'my-org' })
  const heartbeats = () =>
    notes.filter(n => n.method === 'notifications/events/heartbeat')
  await vi.waitFor(() => expect(heartbeats().length).toBeGreaterThan(2), {
    timeout: 5000,
  })
  controller.abort()
  await done
  expect(notes[0]?.params).toMatchObject({ heartbeatMs: 20 })
  expect(nock.isDone()).toBe(true)
  await client.close()
})

const patchable = (id: string, uuid: string) => ({
  id,
  severity: 'critical',
  createdAt: new Date().toISOString(),
  vulnerability: { cveId: 'CVE-2021-44906' },
  locations: [
    {
      patch: { uuid, status: 'patch_available', deprecated: false },
      artifact: { type: 'npm', name: 'minimist', version: '1.2.2' },
    },
    {
      patch: { uuid: null, status: 'patch_unavailable', deprecated: false },
      artifact: { type: 'npm', name: 'minimist', version: '0.0.8' },
    },
  ],
})

test('socket.patch.available fires only for alerts with a certified patch', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcp-events-'))
  const file = path.join(dir, 'alerts.ndjson')
  writeFileSync(file, '')
  process.env['SOCKET_MCP_EVENTS_FAKE_ALERTS_FILE'] = file
  setStaticApiKey('')
  const { client, notes } = await connect()
  const events = () =>
    notes.filter(n => n.method === 'notifications/events/event')
  const { controller, done } = openStream(
    client,
    { org_slug: 'demo' },
    PATCH_AVAILABLE_EVENT,
  )
  await vi.waitFor(() => expect(notes.length).toBeGreaterThan(1))
  const plain = {
    id: 'no-patch',
    severity: 'critical',
    createdAt: new Date().toISOString(),
  }
  appendFileSync(
    file,
    `${JSON.stringify(plain)}\n${JSON.stringify(patchable('fixable', 'patch-1'))}\n`,
  )
  await vi.waitFor(() => expect(events()).toHaveLength(1), { timeout: 5000 })
  const heartbeats = notes.length
  await vi.waitFor(() => expect(notes.length).toBeGreaterThan(heartbeats + 2))
  controller.abort()
  await done
  expect(events()).toHaveLength(1)
  expect(events()[0]?.params).toMatchObject({
    eventId: 'demo:fixable',
    name: PATCH_AVAILABLE_EVENT,
    data: {
      org_slug: 'demo',
      patches: [{ uuid: 'patch-1', purl: 'pkg:npm/minimist@1.2.2' }],
    },
  })
  await client.close()
  rmSync(dir, { recursive: true, force: true })
})

test('socket.patch.available asks the API for patchable alerts only', async () => {
  const scope = nock(API)
    .matchHeader('authorization', 'Bearer tok')
    .get('/v0/orgs/my-org/alerts')
    .query({
      'filters.alertStatus': 'open',
      'filters.cvePatchStatus': 'patch_available',
      per_page: '100',
    })
    .reply(200, { items: [] })
  const { client } = await connect()
  const { controller, done } = openStream(
    client,
    { org_slug: 'my-org' },
    PATCH_AVAILABLE_EVENT,
  )
  await vi.waitFor(() => expect(scope.isDone()).toBe(true), { timeout: 5000 })
  controller.abort()
  await done
  await client.close()
})
