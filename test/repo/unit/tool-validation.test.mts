import { describe, expect, test } from 'vitest'

import { buildToolSpecs } from '../../../lib/server.mts'
import type { ToolValidationResult } from '../../../lib/tool-types.mts'
import { formatToolValidationFailure } from '../../../lib/tool-validation.mts'

const specs = buildToolSpecs()
const toolNames = specs.map(spec => spec.name)
const validArguments: Record<string, Record<string, unknown>> = {
  depscore: {
    packages: [
      {
        depname: 'fictional-package',
        ecosystem: 'npm',
        version: '1.0.0',
      },
    ],
    platform: 'linux-x64',
  },
  organizations: {},
  alerts: {
    org_slug: 'fictional-org',
    severity: 'high,critical',
    status: 'open',
    category: 'quality',
    artifact_type: 'npm',
    artifact_name: 'fictional-package',
    alert_type: 'usesEval',
    repo_slug: 'fictional-repo',
    per_page: 100,
    cursor: 'next-page',
  },
  threat_feed: {
    org_slug: 'fictional-org',
    filter: 'mal',
    ecosystem: 'npm',
    name: 'fictional-package',
    version: '1.0.0',
    is_human_reviewed: true,
    sort: 'updated_at',
    direction: 'desc',
    updated_after: '2026-01-01T00:00:00Z',
    created_after: '2026-01-01T00:00:00Z',
    per_page: 30,
    cursor: 'next-page',
  },
  package_files: {
    ecosystem: 'npm',
    depname: 'fictional-package',
    version: '1.0.0',
    artifactId: 'fictional-artifact',
    platform: 'linux-x64',
  },
  package_file_contents: {
    hash: 'synthetic-file-hash',
    path: 'dist/index.js',
  },
  package_file_grep: {
    hash: 'synthetic-file-hash',
    pattern: 'synthetic-pattern',
    caseInsensitive: true,
    contextLines: 2,
    maxMatches: 20,
    path: 'dist/index.js',
  },
}

function validate(
  toolName: string,
  argumentsValue: unknown,
): ToolValidationResult {
  const spec = specs.find(candidate => candidate.name === toolName)
  if (!spec) {
    throw new Error(`Missing test schema for ${toolName}`)
  }
  return spec.validateInput(argumentsValue)
}

function expectInvalid(toolName: string, argumentsValue: unknown): string {
  const result = validate(toolName, argumentsValue)
  expect(result.valid).toBe(false)
  if (result.valid) {
    throw new Error('Expected schema validation to fail')
  }
  return JSON.stringify(result.issues)
}

describe('tool argument validation', () => {
  test('accepts a valid argument object for all seven tools', () => {
    for (const toolName of toolNames) {
      expect(validate(toolName, validArguments[toolName])).toEqual({
        valid: true,
      })
    }
  })

  test('rejects non-object roots for every tool', () => {
    for (const toolName of toolNames) {
      for (const argumentsValue of [null, [], 'value', 1, undefined]) {
        expect(validate(toolName, argumentsValue)).toMatchObject({
          valid: false,
        })
      }
    }
  })

  test('publishes closed schemas including nested depscore package objects', () => {
    for (const spec of specs) {
      expect(spec.inputSchema['additionalProperties']).toBe(false)
    }
    expect(
      specs.find(spec => spec.name === 'depscore')?.inputSchema,
    ).toMatchObject({
      properties: {
        packages: {
          items: { additionalProperties: false },
        },
      },
    })
  })

  test('rejects omitted required fields', () => {
    for (const toolName of [
      'depscore',
      'alerts',
      'threat_feed',
      'package_files',
      'package_file_contents',
      'package_file_grep',
    ]) {
      expect(validate(toolName, {})).toMatchObject({ valid: false })
    }
    expect(validate('organizations', {})).toEqual({ valid: true })
  })

  test('rejects wrong scalar types and null, object, or array mismatches', () => {
    expect(validate('depscore', { packages: {} })).toMatchObject({
      valid: false,
    })
    expect(validate('depscore', { packages: null })).toMatchObject({
      valid: false,
    })
    expect(
      validate('depscore', { packages: [{ depname: null }] }),
    ).toMatchObject({ valid: false })
    expect(validate('alerts', { org_slug: ['fictional-org'] })).toMatchObject({
      valid: false,
    })
    expect(
      validate('threat_feed', {
        org_slug: 'fictional-org',
        is_human_reviewed: 'true',
      }),
    ).toMatchObject({ valid: false })
    expect(validate('package_file_contents', { hash: null })).toMatchObject({
      valid: false,
    })
  })

  test('rejects invalid enums and integer values', () => {
    expect(
      validate('alerts', { org_slug: 'fictional-org', status: 'pending' }),
    ).toMatchObject({ valid: false })
    expect(
      validate('threat_feed', {
        org_slug: 'fictional-org',
        sort: 'name',
        direction: 'sideways',
      }),
    ).toMatchObject({ valid: false })
    for (const perPage of [0, 1.5, 5001]) {
      expect(
        validate('alerts', {
          org_slug: 'fictional-org',
          per_page: perPage,
        }),
      ).toMatchObject({ valid: false })
    }
    expect(
      validate('alerts', { org_slug: 'fictional-org', per_page: 5000 }),
    ).toMatchObject({ valid: true })
    for (const perPage of [0, 1.5, 101]) {
      expect(
        validate('threat_feed', {
          org_slug: 'fictional-org',
          per_page: perPage,
        }),
      ).toMatchObject({ valid: false })
    }
    expect(
      validate('threat_feed', {
        org_slug: 'fictional-org',
        per_page: 100,
      }),
    ).toMatchObject({ valid: true })
    for (const perPage of [0, 1.5, 5001]) {
      expect(
        validate('alerts', {
          org_slug: 'fictional-org',
          per_page: perPage,
        }),
      ).toMatchObject({ valid: false })
    }
    for (const [contextLines, maxMatches] of [
      [-1, 1],
      [1.5, 1],
      [6, 1],
      [1, 501],
      [1, 1.5],
      [1, 0],
    ]) {
      expect(
        validate('package_file_grep', {
          hash: 'synthetic-file-hash',
          pattern: 'synthetic-pattern',
          contextLines,
          maxMatches,
        }),
      ).toMatchObject({ valid: false })
    }
    for (const [contextLines, maxMatches] of [
      [0, 1],
      [1, 6],
      [5, 500],
    ]) {
      expect(
        validate('package_file_grep', {
          hash: 'synthetic-file-hash',
          pattern: 'synthetic-pattern',
          contextLines,
          maxMatches,
        }),
      ).toMatchObject({ valid: true })
    }
  })

  test('rejects unknown top-level and nested package fields', () => {
    for (const toolName of toolNames) {
      expect(
        validate(toolName, {
          ...validArguments[toolName],
          unexpected: 'synthetic-value',
        }),
      ).toMatchObject({ valid: false })
    }
    expect(
      validate('organizations', { arbitrary: 'synthetic-value' }),
    ).toMatchObject({ valid: false })
    const nestedIssues = expectInvalid('depscore', {
      packages: [
        {
          depname: 'fictional-package',
          unexpected: 'synthetic-value',
        },
      ],
    })
    expect(nestedIssues).toContain('unknown field')
    expect(nestedIssues).toContain('/packages/0/unexpected')
  })

  test('does not mutate accepted arguments or add defaults', () => {
    const argumentsValue = {
      packages: [
        {
          depname: 'fictional-package',
        },
      ],
    }
    expect(validate('depscore', argumentsValue)).toEqual({ valid: true })
    expect(argumentsValue).toEqual({
      packages: [
        {
          depname: 'fictional-package',
        },
      ],
    })
  })

  test('bounds validation details and does not include invalid values', () => {
    const canary = 'synthetic-sensitive-value'
    const issues = expectInvalid('organizations', {
      unexpected: canary,
    })
    expect(issues).toContain('unknown field')
    expect(issues).not.toContain(canary)
    const controlCharacterIssue = expectInvalid('organizations', {
      ['unexpected\u0000field']: canary,
    })
    expect(controlCharacterIssue).toContain('unexpected?field')
    const longField = 'unexpected'.repeat(20)
    const result = validate('organizations', {
      [longField]: canary,
    })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.issues[0]?.path.length).toBeLessThanOrEqual(80)
      const message = formatToolValidationFailure(result)
      expect(message.length).toBeLessThan(150)
      expect(message).not.toContain(canary)
    }
    const manyIssues = validate('organizations', {
      first: 'synthetic',
      second: 'synthetic',
      third: 'synthetic',
      fourth: 'synthetic',
      fifth: 'synthetic',
      sixth: 'synthetic',
    })
    expect(manyIssues.valid).toBe(false)
    if (!manyIssues.valid) {
      expect(manyIssues.issues).toHaveLength(5)
    }
  })
})
