import { describe, expect, test } from 'vitest'

import {
  buildToolAuditEvent,
  extractToolAuditResources,
} from '../../../lib/tool-audit-event.mts'
import { sanitizeToolArguments } from '../../../lib/tool-audit-sanitizer.mts'
import type {
  ToolAuditIdentity,
  ToolAuditOutcome,
} from '../../../lib/tool-audit-event.mts'

const bearerIdentity: ToolAuditIdentity = {
  kind: 'bearer',
  tokenHash: 'sha256:fictional-digest',
}

function serialized(value: unknown): string {
  return JSON.stringify(value)
}

describe('tool audit sanitizer', () => {
  test('redacts nested secrets in objects and arrays', () => {
    const result = sanitizeToolArguments({
      items: [
        {
          token: 'fictional-token-canary',
          secret: 'fictional-secret-canary',
          Api_Key: 'fictional-api-key-canary',
          apiKey: 'fictional-api-key-camel-canary',
          'api-key': 'fictional-api-key-dash-canary',
          authORIZATIONHeader: 'fictional-auth-canary',
          credentials: ['fictional-credential-canary'],
          passwordHint: 'fictional-password-canary',
          private_key: 'fictional-private-key-canary',
          'private-key': 'fictional-private-key-dash-canary',
          nested: { passwd: 'fictional-passwd-canary' },
        },
      ],
    })

    expect(result.truncated).toBe(false)
    expect(serialized(result.args)).not.toMatch(/fictional-.*canary/u)
    expect(serialized(result.args).match(/\[REDACTED\]/gu)).toHaveLength(11)
  })

  test('safely retains hostile property names with null-prototype output', () => {
    const input: Record<string, unknown> = {}
    Object.defineProperty(input, '__proto__', {
      enumerable: true,
      value: { polluted: true },
    })
    input['constructor'] = 'x'
    input['prototype'] = 'y'
    const result = sanitizeToolArguments(input)
    const output = result.args

    expect(Object.getPrototypeOf(output)).toBeNull()
    expect(serialized(output)).toBe(
      '{"__proto__":{"polluted":true},"constructor":"x","prototype":"y"}',
    )
    expect(Reflect.get({}, 'polluted')).toBeUndefined()
  })

  test('does not invoke conversion hooks and retains an independent copy', () => {
    let calls = 0
    const input = {
      safe: 'before',
      toJSON() {
        calls += 1
        return 'leaked'
      },
      toString() {
        calls += 1
        return 'leaked'
      },
    }
    const result = sanitizeToolArguments(input)
    input.safe = 'after'
    expect(calls).toBe(0)
    expect(serialized(result.args)).toContain('before')
    expect(serialized(result.args)).not.toContain('after')
  })

  test('omits accessors without executing them or mutating the source', () => {
    let getterCalls = 0
    const input = { safe: 'value' }
    Object.defineProperty(input, 'secret', {
      enumerable: true,
      get() {
        getterCalls += 1
        return 'fictional-secret-canary'
      },
    })

    const result = sanitizeToolArguments(input)

    expect(getterCalls).toBe(0)
    expect(result.truncated).toBe(true)
    expect(serialized(result.args)).not.toContain('fictional-secret-canary')
    expect(Object.getOwnPropertyDescriptor(input, 'secret')?.get).toBeDefined()
  })

  test('skips inherited and non-enumerable object properties', () => {
    const input: Record<string, unknown> = { visible: 'kept' }
    Object.defineProperty(input, 'hidden', {
      enumerable: false,
      value: 'fictional-hidden-value',
    })
    const result = sanitizeToolArguments(input)
    expect(serialized(result.args)).toBe('{"visible":"kept"}')
    const inherited: Record<string, unknown> = Object.create({
      inherited: 'fictional-inherited-value',
    })
    inherited['visible'] = 'kept'
    const inheritedResult = sanitizeToolArguments(inherited)
    expect(serialized(inheritedResult.args)).toBe('"[OMITTED]"')
    expect(inheritedResult.truncated).toBe(true)
  })

  test('handles cycles and repeated references deterministically', () => {
    const shared = { label: 'same' }
    const input: {
      first: typeof shared
      second: typeof shared
      self?: unknown
    } = {
      first: shared,
      second: shared,
    }
    input.self = input

    const result = sanitizeToolArguments(input)

    expect(result.truncated).toBe(true)
    expect(serialized(result.args)).toBe(
      '{"first":{"label":"same"},"second":"[CIRCULAR]","self":"[CIRCULAR]"}',
    )
  })

  test('bounds depth, item count, UTF-8 strings, and serialized bytes', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: 'too deep' } } } } } } }
    const deepResult = sanitizeToolArguments(deep)
    expect(deepResult.truncated).toBe(true)

    const broad = sanitizeToolArguments(
      Array.from({ length: 500 }, (_, index) => index),
    )
    expect(broad.truncated).toBe(true)
    expect(serialized(broad.args)).toContain('[TRUNCATED]')

    const unicode = '🧪'.repeat(500)
    const unicodeResult = sanitizeToolArguments({ text: unicode })
    expect(unicodeResult.truncated).toBe(true)
    expect(
      Buffer.byteLength(serialized(unicodeResult.args), 'utf8'),
    ).toBeLessThan(600)

    const huge = Array.from({ length: 100 }, () => '🧪'.repeat(200))
    const hugeResult = sanitizeToolArguments(huge)
    expect(hugeResult.truncated).toBe(true)
    expect(Buffer.byteLength(serialized(hugeResult.args), 'utf8')).toBeLessThan(
      8 * 1024,
    )
  })

  test('charges sensitive, accessor, and overlong-key properties to the budget', () => {
    const sensitive: Record<string, unknown> = {}
    const accessors: Record<string, unknown> = {}
    const longKeys: Record<string, unknown> = {}
    let getterCalls = 0
    for (let index = 0; index < 300; index += 1) {
      sensitive[`token-${index}`] = 'fictional-canary'
      Object.defineProperty(accessors, `field-${index}`, {
        enumerable: true,
        get() {
          getterCalls += 1
          return 'fictional-canary'
        },
      })
      longKeys[`${'x'.repeat(140)}-${index}`] = 'fictional-canary'
    }

    const sensitiveResult = sanitizeToolArguments(sensitive)
    const accessorResult = sanitizeToolArguments(accessors)
    const keyResult = sanitizeToolArguments(longKeys)

    expect(sensitiveResult.truncated).toBe(true)
    expect(serialized(sensitiveResult.args)).not.toContain('fictional-canary')
    expect(accessorResult.truncated).toBe(true)
    expect(getterCalls).toBe(0)
    expect(keyResult.truncated).toBe(true)
    expect(serialized(keyResult.args)).not.toContain('fictional-canary')
  })

  test('uses fixed markers for unsupported values and non-finite numbers', () => {
    const result = sanitizeToolArguments({
      bigint: BigInt(1),
      date: new Date(0),
      functionValue() {
        return 'not called'
      },
      infinity: Number.POSITIVE_INFINITY,
      map: new Map([['key', 'value']]),
      missing: undefined,
      nan: Number.NaN,
      set: new Set(['value']),
      symbol: Symbol('private'),
    })

    expect(result.truncated).toBe(true)
    expect(serialized(result.args)).not.toContain('private')
    expect(serialized(result.args)).not.toContain('value')
    expect(serialized(result.args)).toContain('[OMITTED]')
  })

  test('handles null and scalar roots with bounded escaped strings', () => {
    expect(sanitizeToolArguments(null)).toEqual({
      args: null,
      truncated: false,
    })
    expect(sanitizeToolArguments(42)).toEqual({ args: 42, truncated: false })
    for (const value of [
      '"\\\u0000\u0001'.repeat(200),
      '\ud800'.repeat(300),
      '🧪'.repeat(300),
    ]) {
      const result = sanitizeToolArguments(value)
      expect(result.truncated).toBe(true)
      expect(
        Buffer.byteLength(serialized(result.args), 'utf8'),
      ).toBeLessThanOrEqual(8 * 1024)
    }
  })

  test('keeps deterministic bounded serialization for controls and lone surrogates', () => {
    const input = {
      escaped: '\u0000\u0001"\\'.repeat(100),
      lone: '\udfff'.repeat(100),
    }
    const first = sanitizeToolArguments(input)
    const second = sanitizeToolArguments(input)
    expect(serialized(first.args)).toBe(serialized(second.args))
    expect(
      Buffer.byteLength(serialized(first.args), 'utf8'),
    ).toBeLessThanOrEqual(8 * 1024)
  })

  test('marks array tails omitted after byte exhaustion', () => {
    const direct = sanitizeToolArguments(
      Array.from({ length: 100 }, () => 'x'.repeat(512)),
    )
    expect(direct.truncated).toBe(true)
    expect(Array.isArray(direct.args)).toBe(true)
    if (Array.isArray(direct.args)) {
      expect(direct.args.at(-1)).toBe('[TRUNCATED]')
    }
    expect(
      Buffer.byteLength(serialized(direct.args), 'utf8'),
    ).toBeLessThanOrEqual(8 * 1024)

    let getterCalls = 0
    const escaped: unknown[] = Array.from({ length: 100 }, () =>
      '\u0001'.repeat(128),
    )
    Object.defineProperty(escaped, '99', {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1
        return 'never-read'
      },
    })
    const nested = sanitizeToolArguments({ values: escaped })
    expect(getterCalls).toBe(0)
    expect(nested.truncated).toBe(true)
    expect(
      Buffer.byteLength(serialized(nested.args), 'utf8'),
    ).toBeLessThanOrEqual(8 * 1024)
    if (
      typeof nested.args === 'object' &&
      nested.args !== null &&
      !Array.isArray(nested.args)
    ) {
      const values = nested.args['values']
      expect(Array.isArray(values)).toBe(true)
      if (Array.isArray(values)) {
        expect(values.at(-1)).toBe('[TRUNCATED]')
      }
    }

    const noTail = sanitizeToolArguments(
      Array.from({ length: 16 }, () => 'x'.repeat(512)),
    )
    expect(noTail.truncated).toBe(true)
    expect(Array.isArray(noTail.args)).toBe(true)
    if (Array.isArray(noTail.args)) {
      expect(noTail.args.at(-1)).toBe('[OMITTED]')
      expect(noTail.args).not.toContain('[TRUNCATED]')
    }
  })
})

describe('tool audit resource extraction', () => {
  test('extracts resources from valid declared tool coordinates', () => {
    expect(
      extractToolAuditResources(
        'alerts',
        { org_slug: 'fictional-org' },
        {
          inputValidated: true,
        },
      ).resources,
    ).toEqual([{ kind: 'organization', orgSlug: 'fictional-org' }])
    expect(
      extractToolAuditResources(
        'threat_feed',
        { org_slug: 'fictional-org' },
        { inputValidated: true },
      ).resources,
    ).toEqual([{ kind: 'organization', orgSlug: 'fictional-org' }])
    expect(
      extractToolAuditResources(
        'depscore',
        {
          packages: [
            { depname: 'fictional-package' },
            {
              depname: 'fixture',
              ecosystem: 'npm',
              version: '1.2.3',
            },
          ],
          platform: 'linux-x64',
        },
        { inputValidated: true },
      ).resources,
    ).toEqual([
      {
        kind: 'package',
        name: 'fictional-package',
        platform: 'linux-x64',
      },
      {
        kind: 'package',
        ecosystem: 'npm',
        name: 'fixture',
        version: '1.2.3',
        platform: 'linux-x64',
      },
    ])
    expect(
      extractToolAuditResources(
        'package_files',
        {
          artifactId: 'fixture.whl',
          depname: 'fixture',
          ecosystem: 'pypi',
          platform: 'linux-x64',
          version: '2.0.0',
        },
        { inputValidated: true },
      ).resources,
    ).toEqual([
      {
        kind: 'package',
        ecosystem: 'pypi',
        name: 'fixture',
        version: '2.0.0',
        platform: 'linux-x64',
        artifactId: 'fixture.whl',
      },
    ])
    expect(
      extractToolAuditResources(
        'package_file_contents',
        { hash: 'fixture-hash', path: 'display-only.js' },
        { inputValidated: true },
      ).resources,
    ).toEqual([{ kind: 'file', hash: 'fixture-hash' }])
    expect(
      extractToolAuditResources(
        'package_file_grep',
        { hash: 'fixture-hash', path: 'display-only.js' },
        { inputValidated: true },
      ).resources,
    ).toEqual([{ kind: 'file', hash: 'fixture-hash' }])
    expect(
      extractToolAuditResources(
        'organizations',
        {},
        {
          inputValidated: true,
        },
      ).resources,
    ).toEqual([])
  })

  test('does not assign resources to invalid, unknown, or malformed calls', () => {
    expect(
      extractToolAuditResources(
        'alerts',
        { org_slug: 'fictional-org' },
        {
          inputValidated: false,
        },
      ).resources,
    ).toEqual([])
    expect(
      extractToolAuditResources(
        'unknown_tool',
        { org_slug: 'fictional-org' },
        { inputValidated: true },
      ).resources,
    ).toEqual([])
    expect(
      extractToolAuditResources(
        'depscore',
        { packages: 'wrong' },
        {
          inputValidated: true,
        },
      ).resources,
    ).toEqual([])
  })

  test('bounds resource count and omits coordinates that exceed field limits', () => {
    const bounded = extractToolAuditResources(
      'depscore',
      {
        packages: Array.from({ length: 40 }, (_, index) => ({
          depname: `fixture-${index}`,
        })),
      },
      { inputValidated: true },
    )
    expect(bounded.resources).toHaveLength(32)
    expect(bounded.truncated).toBe(true)

    const longCoordinate = extractToolAuditResources(
      'package_files',
      { depname: '🧪'.repeat(100), version: '1.0.0' },
      { inputValidated: true },
    )
    expect(longCoordinate.resources).toEqual([])
    expect(longCoordinate.truncated).toBe(true)

    const boundary = extractToolAuditResources(
      'package_files',
      { depname: 'n'.repeat(256), version: 'v'.repeat(256) },
      { inputValidated: true },
    )
    expect(boundary.resources).toHaveLength(1)
    expect(boundary.truncated).toBe(false)
  })

  test('reads package entries only through own data descriptors', () => {
    let getterCalls = 0
    const packages: unknown[] = [{ depname: 'first' }]
    Object.defineProperty(packages, '0', {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1
        return { depname: 'invented' }
      },
    })
    Object.defineProperty(packages, '32', {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1
        return { depname: 'invented-late' }
      },
    })
    packages[Symbol.iterator] = function* () {
      throw new Error('iterator must not run')
    }
    const result = extractToolAuditResources(
      'depscore',
      { packages },
      { inputValidated: true },
    )
    expect(getterCalls).toBe(0)
    expect(result.resources).toEqual([])
    expect(result.truncated).toBe(true)

    const sparse: unknown[] = new Array(1)
    Object.setPrototypeOf(sparse, { 0: { depname: 'inherited-package' } })
    const sparseResult = extractToolAuditResources(
      'depscore',
      { packages: sparse },
      { inputValidated: true },
    )
    expect(sparseResult.resources).toEqual([])
    expect(sparseResult.truncated).toBe(true)
  })

  test('does not treat invalid outcomes as validated resource lookups', () => {
    expect(
      buildToolAuditEvent(
        'event',
        '2026-10-11T12:00:00.000Z',
        bearerIdentity,
        'alerts',
        'invalid',
        { org_slug: 'fictional-org' },
        { inputValidated: true },
      ).resources,
    ).toEqual([])
  })
})

describe('tool audit v1 event builder', () => {
  test('represents every declared outcome and request ID form', () => {
    const outcomes: readonly ToolAuditOutcome[] = [
      'success',
      'failure',
      'denied',
      'invalid',
      'unknown',
    ]
    for (const outcome of outcomes) {
      expect(
        buildToolAuditEvent(
          'event',
          '2026-10-11T12:00:00.000Z',
          { kind: 'anonymous' },
          'organizations',
          outcome,
          null,
        ).outcome,
      ).toBe(outcome)
    }
    const stringId = buildToolAuditEvent(
      'event',
      '2026-10-11T12:00:00.000Z',
      { kind: 'operator' },
      'organizations',
      'success',
      null,
      { requestId: 'request-id' },
    )
    expect(stringId.requestId).toBe('request-id')
    const invalidId = buildToolAuditEvent(
      'event',
      '2026-10-11T12:00:00.000Z',
      { kind: 'operator' },
      'organizations',
      'success',
      null,
      { requestId: Number.NaN },
    )
    expect(invalidId.requestId).toBeUndefined()
    expect(invalidId.truncated.requestId).toBe(true)
    const oversizedId = buildToolAuditEvent(
      'event',
      '2026-10-11T12:00:00.000Z',
      { kind: 'operator' },
      'organizations',
      'success',
      null,
      { requestId: 'r'.repeat(129) },
    )
    expect(oversizedId.requestId).toBeUndefined()
    expect(oversizedId.truncated.requestId).toBe(true)
  })

  test('separates event and request ids and encodes identity and outcome', () => {
    const outcome: ToolAuditOutcome = 'denied'
    const event = buildToolAuditEvent(
      'generated-event-id',
      '2026-10-11T12:00:00.000Z',
      bearerIdentity,
      'alerts',
      outcome,
      { org_slug: 'fictional-org', token: 'fictional-canary' },
      { inputValidated: true, requestId: 17 },
    )

    expect(event).toMatchObject({
      event: 'socket.mcp.tool_call',
      version: 1,
      eventId: 'generated-event-id',
      requestId: 17,
      timestamp: '2026-10-11T12:00:00.000Z',
      identity: bearerIdentity,
      tool: 'alerts',
      outcome: 'denied',
      resources: [{ kind: 'organization', orgSlug: 'fictional-org' }],
    })
    expect(serialized(event)).not.toContain('fictional-canary')
    expect(serialized(event)).not.toContain('response')
    expect(Object.getPrototypeOf(event)).toBeNull()
  })

  test('represents operator and anonymous identities without token hashes', () => {
    const identities: readonly ToolAuditIdentity[] = [
      { kind: 'operator' },
      { kind: 'anonymous' },
    ]
    for (const identity of identities) {
      const event = buildToolAuditEvent(
        'event',
        '1970-01-01T00:00:00.000Z',
        identity,
        'x',
        'unknown',
        {},
        { inputValidated: false },
      )
      expect(event.identity).toEqual(identity)
      expect(event.timestamp).toBe('1970-01-01T00:00:00.000Z')
      expect(Buffer.byteLength(serialized(event), 'utf8')).toBeLessThan(
        16 * 1024,
      )
    }
  })

  test('rejects over-boundary trusted metadata rather than collapsing prefixes', () => {
    expect(() =>
      buildToolAuditEvent(
        'x'.repeat(129),
        '2026-10-11T12:00:00.000Z',
        bearerIdentity,
        'alerts',
        'success',
        {},
      ),
    ).toThrow(TypeError)
    expect(() =>
      buildToolAuditEvent(
        'event',
        'invalid time',
        bearerIdentity,
        'alerts',
        'success',
        {},
      ),
    ).toThrow(TypeError)
    expect(() =>
      buildToolAuditEvent(
        'event',
        '2026-10-11T12:00:00.000Z',
        { kind: 'bearer', tokenHash: 'x'.repeat(129) },
        'alerts',
        'success',
        {},
      ),
    ).toThrow(TypeError)
    const exact = buildToolAuditEvent(
      'e'.repeat(128),
      '2026-10-11T12:00:00.000Z',
      { kind: 'bearer', tokenHash: 'h'.repeat(128) },
      't'.repeat(128),
      'success',
      {},
    )
    expect(exact.eventId).toHaveLength(128)
    expect(exact.tool).toHaveLength(128)
    expect(exact.truncated.tool).toBe(false)
    expect(exact.identity).toEqual({
      kind: 'bearer',
      tokenHash: 'h'.repeat(128),
    })
  })

  test('bounds untrusted tool names and records name truncation', () => {
    const cases: readonly { name: string; prefix: string }[] = [
      { name: 'x'.repeat(129), prefix: 'x'.repeat(128) },
      { name: `${'a'.repeat(126)}🧪`, prefix: 'a'.repeat(126) },
      {
        name: 'synthetic'.repeat(100_000),
        prefix: 'synthetic'.repeat(15).slice(0, 128),
      },
    ]
    for (const { name, prefix } of cases) {
      const event = buildToolAuditEvent(
        'event-id',
        '2026-10-11T12:00:00.000Z',
        bearerIdentity,
        name,
        'unknown',
        { org_slug: 'fictional-org' },
        { inputValidated: true },
      )
      expect(event).toMatchObject({
        eventId: 'event-id',
        outcome: 'unknown',
        tool: prefix,
        resources: [],
        truncated: { tool: true },
      })
      expect(Buffer.byteLength(event.tool, 'utf8')).toBeLessThanOrEqual(128)
      expect(Buffer.byteLength(serialized(event), 'utf8')).toBeLessThanOrEqual(
        16 * 1024,
      )
    }
  })

  test('bounds a full event when arguments and 32 structured resources are large', () => {
    const packageInputs = Array.from({ length: 32 }, (_, index) => ({
      depname: `p${index}`,
    }))
    const event = buildToolAuditEvent(
      'event',
      '2026-10-11T12:00:00.000Z',
      bearerIdentity,
      'depscore',
      'success',
      {
        payload: Array.from({ length: 15 }, () => 'x'.repeat(480)),
        packages: packageInputs,
      },
      { inputValidated: true, requestId: 'request-id' },
    )
    expect(event.resources).toHaveLength(32)
    expect(Buffer.byteLength(serialized(event.args), 'utf8')).toBeGreaterThan(
      7 * 1024,
    )
    expect(
      Buffer.byteLength(serialized(event.args), 'utf8'),
    ).toBeLessThanOrEqual(8 * 1024)
    expect(Buffer.byteLength(serialized(event), 'utf8')).toBeLessThanOrEqual(
      16 * 1024,
    )
    const oversizedEvent = buildToolAuditEvent(
      'event',
      '2026-10-11T12:00:00.000Z',
      bearerIdentity,
      'depscore',
      'success',
      {
        payload: Array.from({ length: 15 }, () => 'x'.repeat(480)),
        packages: Array.from({ length: 32 }, (_, index) => ({
          depname: `p${index}`,
          ecosystem: 'e'.repeat(240),
          version: 'v'.repeat(240),
          platform: 'p'.repeat(240),
        })),
      },
      { inputValidated: true },
    )
    expect(oversizedEvent.truncated.event).toBe(true)
    expect(oversizedEvent.truncated.resources).toBe(true)
    expect(
      Buffer.byteLength(serialized(oversizedEvent), 'utf8'),
    ).toBeLessThanOrEqual(16 * 1024)
  })
})
