import nock from 'nock'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  buildPackageComponents,
  defineDepscoreTool,
  formatScoreEntries,
  formatScoreLine,
  handleDepscore,
  parseNdjsonPackageBody,
  parseSinglePackageBody,
} from '../lib/tool-depscore.ts'

const API = 'https://api.socket.dev'

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
    expect((result as string[]).length).toBe(2)
  })

  test('returns an error object when no valid JSON objects remain', () => {
    const result = parseNdjsonPackageBody('not json\nalso not json', undefined)
    expect(Array.isArray(result)).toBe(false)
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
})

describe('buildPackageComponents', () => {
  test('strips range prefixes and defaults the ecosystem to npm', () => {
    const components = buildPackageComponents([
      { depname: 'express', version: '^4.18.2' },
    ])
    expect(components).toEqual([{ purl: 'pkg:npm/express@4.18.2' }])
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
  test('handler delegates to handleDepscore', async () => {
    nock(API).disableNetConnect?.()
    const spec = defineDepscoreTool()
    expect(spec.name).toBe('depscore')
    const result = await spec.handler(
      { packages: [{ depname: 'x', version: '2.0.0' }] },
      {},
    )
    // No token in extra and no static key -> AUTH_REQUIRED.
    expect(result.isError).toBe(true)
  })
})
