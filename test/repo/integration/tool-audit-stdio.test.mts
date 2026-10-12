import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { CallToolResult } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  startApiFixture,
  startServerChild,
} from '../fixture/tool-audit-stdio.mts'
import type {
  ManagedChild,
  StdioAuditFixture,
} from '../fixture/tool-audit-stdio.mts'

const TOKEN_CANARY = 'synthetic_stdio_token_canary'
const ARGUMENT_CANARY = 'synthetic_argument_canary'
const RESPONSE_CANARY = 'synthetic_response_canary'

let tempDirectory = ''
let activeChild: ManagedChild | undefined
let fixture: StdioAuditFixture | undefined

function currentFixture(): StdioAuditFixture {
  if (!fixture) {
    throw new TypeError('Loopback API fixture is not running')
  }
  return fixture
}

beforeEach(async () => {
  tempDirectory = mkdtempSync(path.join(tmpdir(), 'mcp-audit-stdio-'))
  fixture = await startApiFixture()
})

afterEach(async () => {
  if (activeChild) {
    await activeChild.close()
    activeChild = undefined
  }
  if (fixture) {
    const activeFixture = fixture
    fixture = undefined
    await activeFixture.close()
  }
  if (tempDirectory) {
    rmSync(tempDirectory, { recursive: true, force: true })
    tempDirectory = ''
  }
})

function readLines(filePath: string): string[] {
  if (!existsSync(filePath)) {
    return []
  }
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(line => line.length > 0)
}

function parseRecord(line: string): Record<string, unknown> {
  const value: unknown = JSON.parse(line)
  if (!isRecord(value)) {
    throw new TypeError('Expected an audit JSON object')
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readStderrEvents(stderrText: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = []
  for (const line of stderrText.split(/\r?\n/u)) {
    if (!line.startsWith('{')) {
      continue
    }
    try {
      const record = parseRecord(line)
      if (record['event'] === 'socket.mcp.tool_call') {
        events.push(record)
      }
    } catch {
      continue
    }
  }
  return events
}

function assertValidEvent(event: Record<string, unknown>): void {
  expect(event).toMatchObject({
    event: 'socket.mcp.tool_call',
    version: 1,
    identity: { kind: 'operator' },
  })
  expect(typeof event['eventId']).toBe('string')
  expect(event['eventId']).not.toBe(event['requestId'])
  expect(
    typeof event['requestId'] === 'string' ||
      typeof event['requestId'] === 'number',
  ).toBe(true)
  expect(event['timestamp']).toMatch(
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u,
  )
  const timestamp = event['timestamp']
  if (typeof timestamp !== 'string') {
    throw new TypeError('Missing audit timestamp')
  }
  expect(new Date(Date.parse(timestamp)).toISOString()).toBe(timestamp)
  const truncated = event['truncated']
  expect(isRecord(truncated)).toBe(true)
  if (!isRecord(truncated)) {
    throw new TypeError('Missing audit truncation fields')
  }
  expect(Object.keys(truncated).toSorted()).toEqual([
    'arguments',
    'event',
    'requestId',
    'resources',
    'tool',
  ])
  for (const value of Object.values(truncated)) {
    expect(typeof value).toBe('boolean')
  }
}

function firstText(result: CallToolResult): string {
  const { 0: block } = result.content
  return block?.type === 'text' ? block.text : ''
}

async function waitForStderrBytes(
  child: ManagedChild,
  expected: number,
): Promise<void> {
  const endAt = Date.now() + 2_000
  while (Buffer.byteLength(child.stderrText(), 'utf8') < expected) {
    if (Date.now() >= endAt) {
      return
    }
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
}

describe('real stdio child audit delivery', () => {
  test('appends one event for each completed tool call and keeps diagnostics safe', async () => {
    const auditPath = path.join(tempDirectory, 'audit.jsonl')
    const sentinel = '{"existing":"sentinel"}\n'
    writeFileSync(auditPath, sentinel)
    const child = await startServerChild(
      currentFixture().endpoint,
      auditPath,
      'jsonl',
    )
    activeChild = child
    try {
      await child.client.listTools()
      expect(readLines(auditPath)).toEqual([sentinel.trimEnd()])
      expect(currentFixture().requestCount).toBe(0)

      const unknown = await child.client.callTool({
        name: 'does-not-exist',
        arguments: {},
      })
      expect(unknown.isError).toBe(true)

      const invalid = await child.client.callTool({
        name: 'depscore',
        arguments: { packages: [], authorization: ARGUMENT_CANARY },
      })
      expect(invalid.isError).toBe(true)

      const invalidRegex = await child.client.callTool({
        name: 'package_file_grep',
        arguments: { hash: 'synthetic-hash', pattern: '[' },
      })
      expect(invalidRegex.isError).toBe(true)
      expect(firstText(invalidRegex)).toContain('Invalid regular expression')
      expect(currentFixture().requestCount).toBe(0)

      currentFixture().setReply({
        body: RESPONSE_CANARY,
        contentType: 'application/json',
        status: 401,
      })
      const unauthorized = await child.client.callTool({
        name: 'depscore',
        arguments: { packages: [{ depname: 'demo', version: '1.0.0' }] },
      })
      expect(unauthorized.isError).toBe(true)
      expect(firstText(unauthorized)).toContain(RESPONSE_CANARY)

      currentFixture().setReply({
        body: RESPONSE_CANARY,
        contentType: 'application/json',
        status: 403,
      })
      const forbidden = await child.client.callTool({
        name: 'depscore',
        arguments: { packages: [{ depname: 'demo', version: '1.0.0' }] },
      })
      expect(forbidden.isError).toBe(true)

      currentFixture().setReply({
        body: RESPONSE_CANARY,
        contentType: 'application/json',
        status: 500,
      })
      const failed = await child.client.callTool({
        name: 'depscore',
        arguments: { packages: [{ depname: 'demo', version: '1.0.0' }] },
      })
      expect(failed.isError).toBe(true)

      currentFixture().setReply({
        body: RESPONSE_CANARY,
        contentType: 'application/json',
        status: 200,
      })
      const malformed = await child.client.callTool({
        name: 'depscore',
        arguments: { packages: [{ depname: 'demo', version: '1.0.0' }] },
      })
      expect(malformed.isError).toBe(true)

      currentFixture().setReply({
        body: `${JSON.stringify({
          type: 'npm',
          name: 'demo',
          version: '1.0.0',
          score: { overall: 0.9 },
        })}\n`,
        contentType: 'application/x-ndjson',
        status: 200,
      })
      const success = await child.client.callTool({
        name: 'depscore',
        arguments: { packages: [{ depname: 'demo', version: '1.0.0' }] },
      })
      expect(success.isError).not.toBe(true)
      expect(currentFixture().requestCount).toBe(5)
      await waitForStderrBytes(child, 1)
    } finally {
      await child.close()
      if (activeChild === child) {
        activeChild = undefined
      }
    }

    const lines = readLines(auditPath)
    expect(lines[0]).toBe(sentinel.trimEnd())
    const eventLines = lines.slice(1)
    expect(eventLines).toHaveLength(8)
    const events = eventLines.map(parseRecord)
    expect(events.map(event => event['outcome'])).toEqual([
      'unknown',
      'invalid',
      'invalid',
      'denied',
      'denied',
      'failure',
      'failure',
      'success',
    ])
    expect(new Set(events.map(event => event['eventId'])).size).toBe(8)
    for (let index = 0; index < events.length; index += 1) {
      assertValidEvent(events[index]!)
      expect(Buffer.byteLength(eventLines[index]!, 'utf8')).toBeLessThanOrEqual(
        16 * 1024,
      )
    }
    expect(JSON.stringify(events)).not.toContain(TOKEN_CANARY)
    expect(JSON.stringify(events)).not.toContain(ARGUMENT_CANARY)
    expect(JSON.stringify(events)).not.toContain(RESPONSE_CANARY)
    const stderr = child.stderrText()
    expect(child.stderrOverflowed()).toBe(false)
    expect(readStderrEvents(stderr)).toHaveLength(0)
    expect(stderr).not.toContain(TOKEN_CANARY)
    expect(stderr).not.toContain(ARGUMENT_CANARY)
    expect(stderr).not.toContain(RESPONSE_CANARY)
  })

  test('writes JSON events to stderr only and keeps stdio protocol usable', async () => {
    const auditPath = path.join(tempDirectory, 'stderr-events.jsonl')
    const child = await startServerChild(
      currentFixture().endpoint,
      auditPath,
      'stderr',
    )
    activeChild = child
    try {
      await child.client.listTools()
      const first = await child.client.callTool({
        name: 'does-not-exist',
        arguments: {},
      })
      expect(first.isError).toBe(true)
      const second = await child.client.callTool({
        name: 'package_file_grep',
        arguments: { hash: 'synthetic-hash', pattern: '[' },
      })
      expect(second.isError).toBe(true)
      expect(firstText(second)).toContain('Invalid regular expression')
      const listed = await child.client.listTools()
      expect(listed.tools.map(tool => tool.name)).toContain('depscore')
      await waitForStderrBytes(child, 1)
    } finally {
      await child.close()
      if (activeChild === child) {
        activeChild = undefined
      }
    }

    expect(existsSync(auditPath)).toBe(false)
    const events = readStderrEvents(child.stderrText())
    expect(events).toHaveLength(2)
    expect(events.map(event => event['outcome'])).toEqual([
      'unknown',
      'invalid',
    ])
    for (const event of events) {
      assertValidEvent(event)
    }
    expect(child.stderrOverflowed()).toBe(false)
    expect(child.stderrText()).not.toContain(TOKEN_CANARY)
  })

  test('keeps calls usable and emits static diagnostics when the file sink fails', async () => {
    const invalidParent = path.join(tempDirectory, 'audit-path-canary')
    writeFileSync(invalidParent, 'regular-file-parent')
    const auditPath = path.join(invalidParent, 'events.jsonl')
    const child = await startServerChild(
      currentFixture().endpoint,
      auditPath,
      'jsonl',
    )
    activeChild = child
    try {
      const first = await child.client.callTool({
        name: 'does-not-exist',
        arguments: {},
      })
      expect(first.isError).toBe(true)
      const listed = await child.client.listTools()
      expect(listed.tools.map(tool => tool.name)).toContain('depscore')
      const second = await child.client.callTool({
        name: 'does-not-exist',
        arguments: {},
      })
      expect(second.isError).toBe(true)
    } finally {
      await child.close()
      if (activeChild === child) {
        activeChild = undefined
      }
    }

    const stderr = child.stderrText()
    expect(stderr.match(/mcp audit log write failed\n/gu)).toHaveLength(2)
    expect(stderr).not.toContain('audit-path-canary')
    expect(stderr).not.toContain(TOKEN_CANARY)
    expect(readStderrEvents(stderr)).toHaveLength(0)
    expect(existsSync(auditPath)).toBe(false)
  })
})
