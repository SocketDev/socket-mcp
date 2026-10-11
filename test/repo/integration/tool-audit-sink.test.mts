import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { safeDelete } from '@socketsecurity/lib-stable/fs/safe'
import { afterAll, describe, expect, test } from 'vitest'

import {
  buildToolAuditEvent,
  TOOL_AUDIT_LIMITS,
} from '../../../lib/tool-audit-event.mts'
import type { ToolAuditEventV1 } from '../../../lib/tool-audit-event.mts'
import { emitToolAuditEvent } from '../../../lib/tool-audit-sink.mts'

const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'socket-audit-sink-'))

function buildSampleEvent(eventId: string): ToolAuditEventV1 {
  return buildToolAuditEvent(
    eventId,
    '2026-10-11T00:00:00.000Z',
    { kind: 'anonymous' },
    'depscore',
    'success',
    {
      token: 'sink-token-canary',
      nested: {
        password: 'sink-password-canary',
        privateKey: 'sink-private-key-canary',
      },
    },
  )
}

function buildEventOfByteLength(byteLength: number): ToolAuditEventV1 {
  const event = { ...buildSampleEvent('size-boundary'), args: '' }
  const encoded = JSON.stringify(event)
  if (encoded === undefined) {
    throw new TypeError('Failed to encode size boundary event')
  }
  const baseByteLength = Buffer.byteLength(encoded, 'utf8')
  if (byteLength < baseByteLength) {
    throw new RangeError('Requested event size is below its fixed fields')
  }
  return { ...event, args: 'x'.repeat(byteLength - baseByteLength) }
}

afterAll(async () => {
  await safeDelete(scratchDir)
})

describe('tool audit file sink', () => {
  test('appends bounded records without exposing sensitive-field canaries', () => {
    const filePath = path.join(scratchDir, 'nested', 'events.jsonl')
    const sentinel = '{"existing":true}\n'
    mkdirSync(path.dirname(filePath), { recursive: true })
    writeFileSync(filePath, sentinel)
    const first = buildSampleEvent('first-event')
    const second = buildSampleEvent('second-event')

    emitToolAuditEvent(first, { path: filePath })
    emitToolAuditEvent(second, { path: filePath })

    const contents = readFileSync(filePath, 'utf8')
    expect(contents.startsWith(sentinel)).toBe(true)
    const records = contents
      .slice(sentinel.length)
      .trimEnd()
      .split('\n')
      .map(line => JSON.parse(line))
    expect(records).toEqual([first, second])
    expect(contents).not.toContain('sink-token-canary')
    expect(contents).not.toContain('sink-password-canary')
    expect(contents).not.toContain('sink-private-key-canary')
  })

  test('writes an event at the byte limit and rejects an oversized event', () => {
    const filePath = path.join(scratchDir, 'size-boundary.jsonl')
    const event = buildEventOfByteLength(TOOL_AUDIT_LIMITS.eventBytes)
    const encoded = JSON.stringify(event)
    if (encoded === undefined) {
      throw new TypeError('Failed to encode maximum-size event')
    }
    expect(Buffer.byteLength(encoded, 'utf8')).toBe(
      TOOL_AUDIT_LIMITS.eventBytes,
    )

    emitToolAuditEvent(event, { path: filePath })
    const contents = readFileSync(filePath, 'utf8')
    expect(contents).toBe(`${encoded}\n`)
    expect(JSON.parse(contents)).toEqual(event)
    if (process.platform !== 'win32') {
      expect(statSync(filePath).mode & 0o777).toBe(0o600)
    }

    emitToolAuditEvent(
      buildEventOfByteLength(TOOL_AUDIT_LIMITS.eventBytes + 1),
      { path: filePath },
    )
    expect(readFileSync(filePath, 'utf8')).toBe(contents)
  })

  test('keeps a write failure from throwing or changing its regular-file parent', () => {
    const parentFile = path.join(scratchDir, 'regular-file-parent')
    const contents = 'parent-file-sentinel'
    writeFileSync(parentFile, contents)

    expect(() =>
      emitToolAuditEvent(buildSampleEvent('failed-write'), {
        path: path.join(parentFile, 'events.jsonl'),
      }),
    ).not.toThrow()
    expect(readFileSync(parentFile, 'utf8')).toBe(contents)
    expect(existsSync(path.join(parentFile, 'events.jsonl'))).toBe(false)
  })
})
