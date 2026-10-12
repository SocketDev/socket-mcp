import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import type { SpawnSyncReturns } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { safeDelete } from '@socketsecurity/lib-stable/fs/safe'
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  buildToolAuditEvent,
  TOOL_AUDIT_LIMITS,
} from '../../../lib/tool-audit-event.mts'
import type { ToolAuditEventV1 } from '../../../lib/tool-audit-event.mts'
import { emitToolAuditEvent } from '../../../lib/tool-audit-sink.mts'

const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'socket-audit-sink-'))
const ORIGINAL_AUDIT_SINK = process.env['SOCKET_MCP_AUDIT_SINK']

beforeEach(() => {
  process.env['SOCKET_MCP_AUDIT_SINK'] = 'jsonl'
})

afterEach(() => {
  if (ORIGINAL_AUDIT_SINK === undefined) {
    delete process.env['SOCKET_MCP_AUDIT_SINK']
  } else {
    process.env['SOCKET_MCP_AUDIT_SINK'] = ORIGINAL_AUDIT_SINK
  }
})

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

const SOURCE_EMITTER = `
import { buildToolAuditEvent } from './lib/tool-audit-event.mts'
import { emitToolAuditEvent } from './lib/tool-audit-sink.mts'

emitToolAuditEvent(
  buildToolAuditEvent(
    'source-child-event',
    '2026-10-11T00:00:00.000Z',
    { kind: 'anonymous' },
    'depscore',
    'success',
    {},
  ),
)
`

function runSourceEmitter(
  sink: string | undefined,
  filePath: string,
): SpawnSyncReturns<string> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SOCKET_MCP_AUDIT_LOG: filePath,
  }
  if (sink === undefined) {
    delete env['SOCKET_MCP_AUDIT_SINK']
  } else {
    env['SOCKET_MCP_AUDIT_SINK'] = sink
  }
  return spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', SOURCE_EMITTER],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env,
      maxBuffer: 64 * 1024,
      timeout: 10_000,
    },
  )
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

  test('writes one compact JSON event to stderr without touching the file', () => {
    const filePath = path.join(scratchDir, 'stderr-mode.jsonl')
    const child = runSourceEmitter('stderr', filePath)
    const event = buildToolAuditEvent(
      'source-child-event',
      '2026-10-11T00:00:00.000Z',
      { kind: 'anonymous' },
      'depscore',
      'success',
      {},
    )

    expect(child.status).toBe(0)
    expect(child.stdout).toBe('')
    expect(child.stderr).toBe(`${JSON.stringify(event)}\n`)
    expect(existsSync(filePath)).toBe(false)
  })

  test('defaults to JSONL and falls back to JSONL for an unknown sink setting', () => {
    const defaultPath = path.join(scratchDir, 'default-mode.jsonl')
    const defaultChild = runSourceEmitter(undefined, defaultPath)
    expect(defaultChild.status).toBe(0)
    expect(defaultChild.stdout).toBe('')
    expect(defaultChild.stderr).toBe('')
    expect(readFileSync(defaultPath, 'utf8')).toContain('source-child-event')

    const fallbackPath = path.join(scratchDir, 'fallback-mode.jsonl')
    const fallbackChild = runSourceEmitter(
      'private_invalid_sink_canary',
      fallbackPath,
    )
    expect(fallbackChild.status).toBe(0)
    expect(fallbackChild.stdout).toBe('')
    expect(fallbackChild.stderr).toBe(
      'mcp audit sink setting invalid; using jsonl\n',
    )
    expect(fallbackChild.stderr).not.toContain('private_invalid_sink_canary')
    expect(readFileSync(fallbackPath, 'utf8')).toContain('source-child-event')
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
