import { describe, expect, test } from 'vitest'

import {
  formatScoreLine,
  parseNdjsonPackageBody,
  parseSinglePackageBody,
} from '../lib/register-depscore.ts'

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
