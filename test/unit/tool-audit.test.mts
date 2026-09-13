import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { safeDelete } from '@socketsecurity/lib-stable/fs/safe'
import { afterAll, afterEach, expect, test, vi } from 'vitest'

import { logger } from '../../lib/logger.mts'
import {
  auditLogPath,
  emitAuditEvent,
  extractResources,
  maskArgs,
  newRequestId,
  tokenIdentity,
} from '../../lib/tool-audit.mts'
import type { AuditEntry } from '../../lib/tool-audit.mts'

const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'socket-audit-test-'))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

afterAll(async () => {
  await safeDelete(scratchDir)
})

test('uses the operator directory when no audit path is configured', () => {
  vi.stubEnv('SOCKET_MCP_AUDIT_LOG', undefined)
  expect(auditLogPath()).toBe(
    path.join(os.homedir(), '.socket', 'mcp-audit.jsonl'),
  )
})

test('creates parent directories and preserves prior audit entries', () => {
  const file = path.join(scratchDir, 'nested', 'events.jsonl')
  vi.stubEnv('SOCKET_MCP_AUDIT_LOG', file)
  const entry: AuditEntry = {
    timestamp: '2026-01-01T00:00:00.000Z',
    identity: 'operator',
    requestId: newRequestId(),
    tool: 'organizations',
    status: 'success',
    resources: ['org:example-org'],
    args: {},
  }
  emitAuditEvent(entry)
  const denied = {
    ...entry,
    requestId: newRequestId(),
    status: 'denied' as const,
  }
  emitAuditEvent(denied)
  expect(
    readFileSync(file, 'utf8')
      .trim()
      .split(/\r?\n/)
      .map(line => JSON.parse(line)),
  ).toEqual([entry, denied])
})

test('logs an audit write failure without failing the tool call', () => {
  const parentFile = path.join(scratchDir, 'parent-file')
  writeFileSync(parentFile, 'example')
  vi.stubEnv('SOCKET_MCP_AUDIT_LOG', path.join(parentFile, 'events.jsonl'))
  const report = vi.spyOn(logger, 'error').mockImplementation(() => logger)
  expect(() =>
    emitAuditEvent({
      timestamp: '2026-01-01T00:00:00.000Z',
      identity: 'operator',
      requestId: newRequestId(),
      tool: 'organizations',
      status: 'failure',
      resources: [],
      args: {},
    }),
  ).not.toThrow()
  expect(report).toHaveBeenCalledTimes(1)
})

test.each([
  [{}, []],
  [{ org: 'example-org', organization: 'other-org' }, ['org:example-org']],
  [{ organization: 'example-org' }, ['org:example-org']],
  [{ org: 42, ecosystem: 42, name: 'example-package', purl: '' }, []],
  [
    { ecosystem: 'npm', depname: 'example-package', version: '1.0.0' },
    ['pkg:npm/example-package@1.0.0'],
  ],
  [
    { ecosystem: 'npm', name: 'example-package', version: 42 },
    ['pkg:npm/example-package'],
  ],
  [
    { purl: 'pkg:npm/example-package@1.0.0' },
    ['purl:pkg:npm/example-package@1.0.0'],
  ],
])('extracts available resource identifiers', (args, resources) => {
  expect(extractResources(args)).toEqual(resources)
})

test('redacts nested sensitive keys without mutating caller arguments', () => {
  const args = {
    Authorization: 'test_fake_token',
    metadata: { API_KEY: 'test_fake_key', name: 'example-package' },
    count: 2,
  }
  expect(maskArgs(args)).toEqual({
    Authorization: '***REDACTED***',
    metadata: { API_KEY: '***REDACTED***', name: 'example-package' },
    count: 2,
  })
  expect(args.metadata.API_KEY).toBe('test_fake_key')
})

test('uses operator identity without a bearer token', () => {
  expect(tokenIdentity(undefined)).toBe('operator')
  expect(tokenIdentity('')).toBe('operator')
})

test('produces stable distinct pseudonymous token identities', () => {
  const identity = tokenIdentity('test_fake_token')
  expect(identity).toMatch(/^sha256:[a-f0-9]{16}$/u)
  expect(tokenIdentity('test_fake_token')).toBe(identity)
  expect(tokenIdentity('test_fake_other_token')).not.toBe(identity)
})
