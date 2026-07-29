import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import type { CallToolResult } from '@modelcontextprotocol/client'
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
  toToolHandlerExtra,
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

  test('every input schema is plain JSON Schema with no symbol keys', () => {
    const specs = buildToolSpecs()
    for (const spec of specs) {
      expect(symbolKeyPaths(spec.inputSchema, spec.name)).toEqual([])
    }
  })
})

// Every symbol-keyed property reachable from `value`, as dotted paths. TypeBox
// hangs `Symbol(TypeBox.Kind)` and `Symbol(TypeBox.Optional)` off the schema
// objects it builds; JSON Schema has no symbol keys, so a non-empty result
// means a schema reached a consumer unlaundered.
function symbolKeyPaths(value: unknown, path: string): string[] {
  if (!value || typeof value !== 'object') {
    return []
  }
  const paths = Object.getOwnPropertySymbols(value).map(
    sym => `${path} :: ${String(sym)}`,
  )
  for (const [key, child] of Object.entries(value)) {
    paths.push(...symbolKeyPaths(child, `${path}.${key}`))
  }
  return paths
}

// The text of a tool result's first content block. `content` is a union of
// block kinds, so narrow on `type` rather than casting.
function firstText(result: CallToolResult): string {
  const [block] = result.content
  return block?.type === 'text' ? block.text : ''
}

describe('createConfiguredServer', () => {
  test('builds a Server instance with every tool registered', () => {
    const server = createConfiguredServer()
    expect(server).toBeTruthy()
    expect(typeof server.setRequestHandler).toBe('function')
  })

  // This case guards schema plainness. `InMemoryTransport` hands each message
  // to the client by reference, so a `tools/list` result carrying the
  // symbol-keyed metadata TypeBox attaches to a schema object fails the
  // client's result validation here. Serializing transports would hide the
  // problem, so keep the plain linked pair — do not wrap it in a JSON round
  // trip.
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
    const known = await client.callTool({
      name: 'organizations',
      arguments: {},
    })
    expect(known.isError).toBe(true)
    expect(firstText(known)).toMatch(/Authentication is required/)

    // An unknown tool returns the "Unknown tool" error result.
    const unknown = await client.callTool({
      name: 'does-not-exist',
      arguments: {},
    })
    expect(unknown.isError).toBe(true)
    expect(firstText(unknown)).toMatch(/Unknown tool: does-not-exist/)

    // A call with no `arguments` at all still reaches the handler — the
    // SDK leaves the field off, and routing substitutes an empty bag.
    const bare = await client.callTool({ name: 'organizations' })
    expect(bare.isError).toBe(true)
    expect(firstText(bare)).toMatch(/Authentication is required/)

    await client.close()
    await server.close()
  })
})

describe('toToolHandlerExtra', () => {
  test('forwards the HTTP transport authInfo to the tool layer', () => {
    const authInfo = { token: 'tok', clientId: 'c', scopes: [] }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
    const ctx = { http: { authInfo } } as unknown as Parameters<
      typeof toToolHandlerExtra
    >[0]
    expect(toToolHandlerExtra(ctx).authInfo).toBe(authInfo)
  })

  test('hands stdio callers an empty extra so they fall back to the static key', () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
    const ctx = {} as unknown as Parameters<typeof toToolHandlerExtra>[0]
    expect(toToolHandlerExtra(ctx)).toEqual({})
  })
})
