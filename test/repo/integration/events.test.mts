import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import type { StandardSchemaV1 } from '@modelcontextprotocol/client'
import nock from 'nock'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { ALERT_CREATED_EVENT, EVENTS_EXTENSION } from '../../../lib/events.mts'
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
  delete process.env['SOCKET_MCP_EVENTS_FAKE_ALERT']
  setStaticApiKey('')
})

test('advertises the events extension and lists socket.alert.created', async () => {
  const { client } = await connect()
  expect(client.getServerCapabilities()?.extensions).toEqual({
    [EVENTS_EXTENSION]: {},
  })
  const result = await client.request(
    { method: 'events/list', params: {} },
    anything,
  )
  const events = result['events'] as Array<Record<string, unknown>>
  expect(events).toHaveLength(1)
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

test('fake-alert mode emits a synthetic alert without calling the API', async () => {
  process.env['SOCKET_MCP_EVENTS_FAKE_ALERT'] = '1'
  setStaticApiKey('')
  const { client, notes } = await connect()
  const { controller, done } = openStream(client, { org_slug: 'demo' })
  await vi.waitFor(
    () =>
      expect(
        notes.filter(n => n.method === 'notifications/events/event').length,
      ).toBeGreaterThanOrEqual(2),
    { timeout: 5000 },
  )
  controller.abort()
  await done
  const ids = notes
    .filter(n => n.method === 'notifications/events/event')
    .map(n => n.params['eventId'])
  expect(new Set(ids).size).toBe(ids.length)
  expect(ids[0]).toBe('demo:fake-alert-1')
  await client.close()
})
