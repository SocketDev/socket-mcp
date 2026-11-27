import { createHash } from 'node:crypto'

import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import type { StandardSchemaV1 } from '@modelcontextprotocol/client'
import { expect, test } from 'vitest'

import { EVENTS_EXTENSION } from '../../../lib/events.mts'
import { createConfiguredServer } from '../../../lib/server.mts'
import {
  PATCH_SKILL_URI,
  SKILLS_EXTENSION,
  WATCH_SKILL_URI,
} from '../../../lib/skills.mts'

const anything: StandardSchemaV1<unknown, Record<string, unknown>> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: value => ({ value: value as Record<string, unknown> }),
  },
}

async function connect(): Promise<Client> {
  const server = createConfiguredServer(undefined, 'stdio')
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client(
    { name: 'test', version: '0.0.0' },
    { capabilities: {} },
  )
  await client.connect(clientTransport)
  return client
}

test('advertises skills, events and resources together', async () => {
  const client = await connect()
  const capabilities = client.getServerCapabilities()
  expect(capabilities?.extensions).toEqual({
    [EVENTS_EXTENSION]: {},
    [SKILLS_EXTENSION]: {},
  })
  expect(capabilities?.resources).toEqual({})
  expect(capabilities?.tools).toBeDefined()
  await client.close()
})

test('skills/list manifests match the bytes resources/read serves', async () => {
  const client = await connect()
  const list = await client.request(
    { method: 'skills/list', params: {} },
    anything,
  )
  const skills = list['skills'] as Array<Record<string, any>>
  expect(skills.map(skill => skill['uri'])).toEqual([
    WATCH_SKILL_URI,
    PATCH_SKILL_URI,
  ])
  expect(list['ttlMs']).toBeGreaterThan(0)

  for (const skill of skills) {
    const name = skill['frontmatter']['name'] as string
    expect(skill['uri']).toBe(`skill://socket/${name}/SKILL.md`)
    const read = await client.readResource({ uri: skill['uri'] })
    const text = (read.contents[0] as { text: string }).text
    expect(text.startsWith(`---\nname: ${name}\n`)).toBe(true)
    expect(skill['resources']).toEqual([
      {
        uri: skill['uri'],
        digest: `sha256:${createHash('sha256').update(text).digest('hex')}`,
        size: Buffer.byteLength(text),
      },
    ])
  }

  const { resources } = await client.listResources()
  expect(resources.map(r => r.uri)).toEqual([WATCH_SKILL_URI, PATCH_SKILL_URI])
  await client.close()
})

test('skills/get returns the skill and rejects unknown uris', async () => {
  const client = await connect()
  const got = await client.request(
    { method: 'skills/get', params: { uri: WATCH_SKILL_URI } },
    anything,
  )
  expect((got['skill'] as Record<string, unknown>)['uri']).toBe(WATCH_SKILL_URI)
  await expect(
    client.request(
      { method: 'skills/get', params: { uri: 'skill://socket/nope/SKILL.md' } },
      anything,
    ),
  ).rejects.toMatchObject({ code: -32_602 })
  await expect(
    client.readResource({ uri: 'skill://socket/nope/SKILL.md' }),
  ).rejects.toMatchObject({ code: -32_602 })
  await client.close()
})
