/**
 * @file The `tools/list` entry shape. `annotations` is optional on `ToolSpec`,
 *   so both the annotated and the un-annotated rendering are asserted here —
 *   every shipping tool sets annotations today, and the extension point has to
 *   keep working for one that does not.
 */

import { describe, expect, test } from 'vitest'

import { buildToolSpecs, toToolListEntry } from '../../lib/server.ts'
import type { ToolSpec } from '../../lib/tool-types.ts'

function bareSpec(overrides?: Partial<ToolSpec> | undefined): ToolSpec {
  return {
    name: 'example',
    title: 'Example Tool',
    description: 'An example.',
    inputSchema: { type: 'object' },
    handler: () => ({ content: [{ type: 'text', text: 'ok' }] }),
    ...overrides,
  }
}

describe('toToolListEntry', () => {
  test('publishes annotations when the spec declares them', () => {
    const entry = toToolListEntry(
      bareSpec({ annotations: { readOnlyHint: true } }),
    )
    expect(entry).toEqual({
      name: 'example',
      title: 'Example Tool',
      description: 'An example.',
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: true },
    })
  })

  test('omits the key entirely for a spec with no annotations', () => {
    const entry = toToolListEntry(bareSpec())
    expect(entry).toEqual({
      name: 'example',
      title: 'Example Tool',
      description: 'An example.',
      inputSchema: { type: 'object' },
    })
    expect('annotations' in entry).toBe(false)
  })
})

describe('the shipped tool set', () => {
  test('every tool renders with its annotations intact', () => {
    const entries = buildToolSpecs().map(toToolListEntry)
    expect(entries.map(entry => entry.name)).toEqual([
      'depscore',
      'organizations',
      'alerts',
      'threat_feed',
      'package_files',
      'package_file_contents',
      'package_file_grep',
    ])
    for (let i = 0, { length } = entries; i < length; i += 1) {
      const entry = entries[i]!
      expect(entry.annotations).toEqual({ readOnlyHint: true })
    }
  })
})
