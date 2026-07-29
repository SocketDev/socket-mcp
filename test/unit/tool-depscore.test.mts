import nock from 'nock'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  buildPackageComponents,
  defineDepscoreTool,
  formatScoreEntries,
  formatScoreLine,
  handleDepscore,
  parseNdjsonPackageBody,
  parseSinglePackageBody,
} from '../../lib/tool-depscore.ts'

const API = 'https://api.socket.dev'

interface PackagesItemSchema {
  required: string[]
  properties: Record<string, { default?: string | undefined } | undefined>
}

// Read back the JSON Schema the tool ships to clients for one `packages[]`
// entry. TypeBox emits plain JSON Schema, so this is the exact object a client
// compiles into its request validator.
function packagesItemSchema(): PackagesItemSchema {
  const { properties } = defineDepscoreTool().inputSchema
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the emitted schema is typed as generic JSON; the asserted shape is fixed by the tool's own Type.Object definition.
  const packages = properties!['packages'] as unknown as {
    items: PackagesItemSchema
  }
  return packages.items
}

describe('formatScoreLine', () => {
  test('renders a scored package with a report URL', () => {
    const line = formatScoreLine({
      type: 'npm',
      name: 'express',
      version: '4.18.2',
      score: { overall: 0.9, supply_chain: 1, quality: 0.9 },
    })
    expect(line).toContain('pkg:npm/express@4.18.2:')
    expect(line).toContain('supply_chain: 100')
    expect(line).toContain('Report: https://socket.dev/npm/package/express')
  })

  test('renders "No score found" when overall is absent', () => {
    expect(formatScoreLine({ type: 'npm', name: 'x', version: '1.2.3' })).toBe(
      'pkg:npm/x@1.2.3: No score found',
    )
  })

  test('keeps the namespace segment of a scoped purl', () => {
    const line = formatScoreLine({
      type: 'npm',
      namespace: '@types',
      name: 'node',
      version: '22.0.0',
      score: { overall: 0.9, quality: 0.9 },
    })
    expect(line).toContain('pkg:npm/@types/node@22.0.0:')
  })

  test('substitutes "unknown" for every purl part the API left off', () => {
    // A record with no usable type / name / version still renders a
    // well-formed purl instead of stringifying undefined into the template.
    expect(formatScoreLine({ score: { overall: 0.4 } })).toContain(
      'pkg:unknown/unknown@unknown:',
    )
  })

  test('substitutes "unknown" for non-string purl parts', () => {
    expect(
      formatScoreLine({ type: 42, name: {}, version: [], namespace: 7 }),
    ).toBe('pkg:unknown/unknown@unknown: No score found')
  })
})

describe('parseNdjsonPackageBody', () => {
  test('parses valid lines and drops _type control frames', () => {
    const body = [
      JSON.stringify({ _type: 'meta', note: 'ignored' }),
      JSON.stringify({
        type: 'npm',
        name: 'a',
        version: '1.2.3',
        score: { overall: 0.8, quality: 0.8 },
      }),
    ].join('\n')
    const result = parseNdjsonPackageBody(body, undefined)
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(1)
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
    expect((result as string[])[0]).toContain('pkg:npm/a@1.2.3:')
  })

  test('skips a malformed line instead of throwing the whole batch', () => {
    const body = [
      JSON.stringify({
        type: 'npm',
        name: 'good',
        version: '2.0.0',
        score: { overall: 0.9, quality: 0.9 },
      }),
      '{ this is not json',
      JSON.stringify({
        type: 'npm',
        name: 'good2',
        version: '3.0.0',
        score: { overall: 0.9, quality: 0.9 },
      }),
    ].join('\n')
    const result = parseNdjsonPackageBody(body, undefined)
    expect(Array.isArray(result)).toBe(true)
    // both valid lines survive; the garbage line is skipped
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
    expect((result as string[]).length).toBe(2)
  })

  test('skips blank lines between documents', () => {
    const body = [
      '',
      JSON.stringify({
        type: 'npm',
        name: 'a',
        version: '1.0.0',
        score: { overall: 0.8, quality: 0.8 },
      }),
      '   ',
      '',
    ].join('\n')
    const result = parseNdjsonPackageBody(body, undefined)
    // The trailing newline an NDJSON producer emits must not count as a
    // malformed document.
    expect(result).toHaveLength(1)
  })

  test('returns an error object when no valid JSON objects remain', () => {
    const result = parseNdjsonPackageBody('not json\nalso not json', undefined)
    expect(Array.isArray(result)).toBe(false)
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
    expect((result as { error: string }).error).toMatch(/No valid JSON objects/)
  })
})

describe('parseSinglePackageBody', () => {
  test('parses a single JSON document into one line', () => {
    const body = JSON.stringify({
      type: 'pypi',
      name: 'requests',
      version: '2.31.0',
      score: { overall: 0.95, quality: 0.95 },
    })
    const result = parseSinglePackageBody(body)
    expect(result).toHaveLength(1)
    expect(result[0]).toContain('pkg:pypi/requests@2.31.0:')
  })
})

describe('formatScoreEntries', () => {
  test('renders sub-1 scores as percentages and skips overall/uuid', () => {
    const out = formatScoreEntries({
      overall: 0.5,
      uuid: 'abc',
      quality: 0.9,
      supplyChain: 0.42,
    })
    expect(out).toBe('quality: 90, supplyChain: 42')
  })

  test('passes through values above 1 unchanged', () => {
    expect(formatScoreEntries({ vulnerabilities: 3 })).toBe(
      'vulnerabilities: 3',
    )
  })

  test('passes a non-numeric value through raw instead of rendering NaN', () => {
    const out = formatScoreEntries({ quality: 'n/a', supplyChain: 0.9 })
    expect(out).toBe('quality: n/a, supplyChain: 90')
    expect(out).not.toContain('NaN')
  })

  test('JSON-encodes a non-string non-numeric value instead of collapsing it', () => {
    // A bare template interpolation would render "[object Object]" and lose
    // whatever the API actually sent.
    const out = formatScoreEntries({ quality: { note: 'pending' } })
    expect(out).toBe('quality: {"note":"pending"}')
  })
})

describe('buildPackageComponents', () => {
  test('strips range prefixes and defaults the ecosystem to npm', () => {
    const components = buildPackageComponents([
      { depname: 'express', version: '^4.18.2' },
    ])
    expect(components).toEqual([{ purl: 'pkg:npm/express@4.18.2' }])
  })

  test('defaults both ecosystem and version when only depname is given', () => {
    // The ecosystem default supplies the `npm` purl type; the `unknown`
    // version default is a placeholder buildPurl leaves off the purl.
    expect(buildPackageComponents([{ depname: 'lodash' }])).toEqual([
      { purl: 'pkg:npm/lodash' },
    ])
  })
})

describe('handleDepscore', () => {
  beforeEach(() => {
    nock.disableNetConnect()
  })

  afterEach(() => {
    nock.cleanAll()
    nock.enableNetConnect()
  })

  test('returns AUTH_REQUIRED when no token is resolvable', async () => {
    const result = await handleDepscore(
      [{ depname: 'express', version: '4.18.2' }],
      undefined,
      undefined,
    )
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/Authentication is required/)
  })

  test('renders a single-document JSON response', async () => {
    nock(API)
      .post('/v0/purl')
      .query(true)
      .reply(
        200,
        JSON.stringify({
          type: 'npm',
          name: 'express',
          version: '4.18.2',
          score: { overall: 0.9, supply_chain: 1 },
        }),
        { 'content-type': 'application/json' },
      )

    const result = await handleDepscore(
      [{ ecosystem: 'npm', depname: 'express', version: '4.18.2' }],
      undefined,
      'tok',
    )
    expect(result.isError).toBeUndefined()
    expect(result.content[0]!.text).toMatch(/Dependency scores:/)
    expect(result.content[0]!.text).toMatch(/pkg:npm\/express@4.18.2/)
  })

  test('parses an NDJSON response body', async () => {
    const body = [
      JSON.stringify({ _type: 'meta' }),
      JSON.stringify({
        type: 'npm',
        name: 'a',
        version: '2.0.0',
        score: { overall: 0.8 },
      }),
    ].join('\n')
    nock(API)
      .post('/v0/purl')
      .query(true)
      .reply(200, body, { 'content-type': 'application/x-ndjson' })

    const result = await handleDepscore(
      [{ depname: 'a', version: '2.0.0' }],
      undefined,
      'tok',
    )
    expect(result.content[0]!.text).toMatch(/pkg:npm\/a@2.0.0/)
  })

  test('surfaces a 401 as an auth error', async () => {
    nock(API).post('/v0/purl').query(true).reply(401, 'nope')
    const result = await handleDepscore(
      [{ depname: 'a', version: '2.0.0' }],
      undefined,
      'tok',
    )
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/authentication failed \[401\]/)
  })

  test('surfaces a 403 as a permission error', async () => {
    nock(API).post('/v0/purl').query(true).reply(403, 'denied')
    const result = await handleDepscore(
      [{ depname: 'a', version: '2.0.0' }],
      undefined,
      'tok',
    )
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/denied access \[403\]/)
  })

  test('reports an empty body as no packages found', async () => {
    nock(API)
      .post('/v0/purl')
      .query(true)
      .reply(200, '', { 'content-type': 'application/json' })
    const result = await handleDepscore(
      [{ depname: 'a', version: '2.0.0' }],
      undefined,
      'tok',
    )
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/No packages were found/)
  })

  test('surfaces a generic non-200 status', async () => {
    nock(API).post('/v0/purl').query(true).reply(503, 'unavailable')
    const result = await handleDepscore(
      [{ depname: 'a', version: '2.0.0' }],
      undefined,
      'tok',
    )
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(
      /Error processing packages: \[503\]/,
    )
  })

  test('returns a connection error when the request throws', async () => {
    nock(API).post('/v0/purl').query(true).replyWithError('socket hang up')
    const result = await handleDepscore(
      [{ depname: 'a', version: '2.0.0' }],
      undefined,
      'tok',
    )
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/Error connecting to Socket API/)
  })

  test('errors when an NDJSON body has no valid objects', async () => {
    nock(API)
      .post('/v0/purl')
      .query(true)
      .reply(200, 'not json\nalso not json', {
        'content-type': 'application/x-ndjson',
      })
    const result = await handleDepscore(
      [{ depname: 'a', version: '2.0.0' }],
      undefined,
      'tok',
    )
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/No valid JSON objects/)
  })

  test('treats a body with no content-type as a single JSON document', async () => {
    nock(API)
      .post('/v0/purl')
      .query(true)
      .reply(
        200,
        JSON.stringify({
          type: 'npm',
          name: 'express',
          version: '4.18.2',
          score: { overall: 0.9, quality: 0.9 },
        }),
      )
    const result = await handleDepscore(
      [{ depname: 'express', version: '4.18.2' }],
      undefined,
      'tok',
    )
    expect(result.isError).toBeUndefined()
    expect(result.content[0]!.text).toMatch(/pkg:npm\/express@4.18.2/)
  })

  test('handles a JSON parse failure on a single-document body', async () => {
    nock(API)
      .post('/v0/purl')
      .query(true)
      .reply(200, '{ broken', { 'content-type': 'application/json' })
    const result = await handleDepscore(
      [{ depname: 'a', version: '2.0.0' }],
      undefined,
      'tok',
    )
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(
      /Error parsing response from Socket/,
    )
  })
})

describe('depscore tool spec', () => {
  afterEach(() => {
    nock.cleanAll()
    nock.enableNetConnect()
  })

  test('handler delegates to handleDepscore', async () => {
    nock.disableNetConnect()
    const spec = defineDepscoreTool()
    expect(spec.name).toBe('depscore')
    const result = await spec.handler(
      { packages: [{ depname: 'x', version: '2.0.0' }] },
      {},
    )
    // No token in extra and no static key -> AUTH_REQUIRED.
    expect(result.isError).toBe(true)
  })

  test('requires only depname on a packages[] entry', () => {
    const items = packagesItemSchema()
    expect(items.required).toEqual(['depname'])
  })

  test('keeps the ecosystem and version defaults on the optional fields', () => {
    const { properties } = packagesItemSchema()
    expect(properties['ecosystem']?.default).toBe('npm')
    expect(properties['version']?.default).toBe('unknown')
  })

  test('accepts a packages entry carrying only depname', async () => {
    nock.disableNetConnect()
    // The interceptor's body matcher is the assertion: it matches only when
    // the handler defaults the absent ecosystem and version into the purl.
    nock(API)
      .post('/v0/purl', { components: [{ purl: 'pkg:npm/lodash' }] })
      .query(true)
      .reply(
        200,
        JSON.stringify({
          type: 'npm',
          name: 'lodash',
          version: '4.17.21',
          score: { overall: 0.9, quality: 0.9 },
        }),
        { 'content-type': 'application/json' },
      )

    const result = await defineDepscoreTool().handler(
      { packages: [{ depname: 'lodash' }] },
      { authInfo: { token: 'tok' } },
    )
    expect(result.isError).toBeUndefined()
    expect(result.content[0]!.text).toMatch(/pkg:npm\/lodash@4.17.21/)
  })
})

describe('local-stack mode', () => {
  afterEach(() => {
    nock.cleanAll()
    nock.enableNetConnect()
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  test('SOCKET_DEBUG points depscore at the local Socket stack', async () => {
    vi.stubEnv('SOCKET_DEBUG', '1')
    // The explicit override wins over the debug default, so clear it.
    vi.stubEnv('SOCKET_API_BASE_URL', '')
    vi.resetModules()
    nock.disableNetConnect()
    nock.enableNetConnect('localhost:8866')
    // The interceptor host is the assertion: it only matches when the debug
    // default replaced api.socket.dev.
    nock('http://localhost:8866')
      .post('/v0/purl')
      .query(true)
      .reply(
        200,
        JSON.stringify({
          type: 'npm',
          name: 'local',
          version: '1.0.0',
          score: { overall: 0.7, quality: 0.7 },
        }),
        { 'content-type': 'application/json' },
      )

    const local = await import('../../lib/tool-depscore.ts')
    const result = await local.handleDepscore(
      [{ depname: 'local', version: '1.0.0' }],
      undefined,
      'tok',
    )
    expect(result.isError).toBeUndefined()
    expect(result.content[0]!.text).toMatch(/pkg:npm\/local@1.0.0/)
  })
})
