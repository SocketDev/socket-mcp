import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, test } from 'vitest'

import {
  authRequiredResult,
  buildToolSpecs,
  createConfiguredServer,
  errorResult,
  getStaticApiKey,
  resolveAuthToken,
  resolveScopedAuthToken,
  setStaticApiKey,
} from '../../lib/server.ts'

afterEach(() => {
  // Reset module-level static-key state so cases don't leak into each other.
  setStaticApiKey('')
})

test('resolveAuthToken prefers the per-request token', () => {
  setStaticApiKey('static-key', { shared: true })
  expect(resolveAuthToken('req-token')).toBe('req-token')
})

test('resolveAuthToken falls back to the static key for public data', () => {
  setStaticApiKey('static-key', { shared: true })
  expect(resolveAuthToken(undefined)).toBe('static-key')
})

test('resolveAuthToken returns undefined when nothing is set', () => {
  expect(resolveAuthToken(undefined)).toBeUndefined()
})

test('resolveScopedAuthToken prefers the per-request token', () => {
  setStaticApiKey('operator-key', { shared: true })
  expect(resolveScopedAuthToken('caller-token')).toBe('caller-token')
})

test('resolveScopedAuthToken uses the static key in stdio mode (user-owned)', () => {
  setStaticApiKey('user-key', { shared: false })
  expect(resolveScopedAuthToken(undefined)).toBe('user-key')
})

test('resolveScopedAuthToken refuses a shared deploy key in HTTP mode', () => {
  setStaticApiKey('operator-key', { shared: true })
  expect(resolveScopedAuthToken(undefined)).toBeUndefined()
})

test('setStaticApiKey defaults shared to false', () => {
  setStaticApiKey('user-key')
  expect(resolveScopedAuthToken(undefined)).toBe('user-key')
})

test('getStaticApiKey returns the most recently set value', () => {
  setStaticApiKey('abc')
  expect(getStaticApiKey()).toBe('abc')
})

describe('result helpers', () => {
  test('errorResult marks isError with the message text', () => {
    const r = errorResult('boom')
    expect(r.isError).toBe(true)
    expect(r.content[0]!.text).toBe('boom')
  })

  test('authRequiredResult is an error result mentioning authentication', () => {
    const r = authRequiredResult()
    expect(r.isError).toBe(true)
    expect(r.content[0]!.text).toMatch(/Authentication is required/)
  })
})

describe('buildToolSpecs', () => {
  test('returns the canonical tool set in order', () => {
    const names = buildToolSpecs().map(s => s.name)
    expect(names).toEqual([
      'depscore',
      'organizations',
      'alerts',
      'threat_feed',
      'package_files',
      'package_file_contents',
      'package_file_grep',
    ])
  })

  test('every spec carries a description and input schema', () => {
    const specs = buildToolSpecs()
    for (let i = 0, { length } = specs; i < length; i += 1) {
      const spec = specs[i]!
      expect(typeof spec.description).toBe('string')
      expect(spec.inputSchema).toBeTruthy()
    }
  })
})

describe('createConfiguredServer', () => {
  test('builds a Server instance with every tool registered', () => {
    const server = createConfiguredServer()
    expect(server).toBeTruthy()
    expect(typeof server.setRequestHandler).toBe('function')
  })

  test('lists tools and dispatches calls over a transport', async () => {
    const server = createConfiguredServer()
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client(
      { name: 'test', version: '0.0.0' },
      { capabilities: {} },
    )
    await client.connect(clientTransport)

    const { tools } = await client.listTools()
    expect(tools.map(t => t.name)).toContain('organizations')

    // A known tool dispatches to its handler; with no token it returns the
    // structured AUTH_REQUIRED error rather than throwing.
    const known = (await client.callTool({
      name: 'organizations',
      arguments: {},
    })) as { isError?: boolean | undefined; content: Array<{ text: string }> }
    expect(known.isError).toBe(true)
    expect(known.content[0]!.text).toMatch(/Authentication is required/)

    // An unknown tool returns the "Unknown tool" error result.
    const unknown = (await client.callTool({
      name: 'does-not-exist',
      arguments: {},
    })) as { isError?: boolean | undefined; content: Array<{ text: string }> }
    expect(unknown.isError).toBe(true)
    expect(unknown.content[0]!.text).toMatch(/Unknown tool: does-not-exist/)

    await client.close()
    await server.close()
  })
})
