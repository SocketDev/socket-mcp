import { describe, expect, test } from 'vitest'

import { isChunkedManifest } from '../../../lib/blob.mts'
import {
  buildToolSpecs,
  isJsonObject,
  isJsonValue,
  isToolInputSchema,
  toPlainSchemaSpec,
} from '../../../lib/server.mts'

describe('decoded input boundaries', () => {
  test('accepts JSON values and rejects unsupported values', () => {
    for (const value of [null, 'value', 1, true, [], { nested: [false] }]) {
      expect(isJsonValue(value)).toBe(true)
    }
    for (const value of [undefined, NaN, Infinity, 1n, Symbol(), new Date()]) {
      expect(isJsonValue(value)).toBe(false)
    }
    expect(isJsonObject({ nested: [null, 'value'] })).toBe(true)
    expect(isJsonObject({ nested: undefined })).toBe(false)
    expect(isJsonObject([])).toBe(false)
  })

  test('validates object schemas before exposing them', () => {
    expect(isToolInputSchema({ type: 'object' })).toBe(true)
    expect(
      isToolInputSchema({
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      }),
    ).toBe(true)
    expect(
      isToolInputSchema({
        type: 'object',
        properties: undefined,
        required: undefined,
      }),
    ).toBe(true)
    for (const value of [
      null,
      [],
      { type: 'string' },
      { type: 'object', properties: [] },
      { type: 'object', properties: { query: undefined } },
      { type: 'object', required: 'query' },
      { type: 'object', required: [1] },
    ]) {
      expect(isToolInputSchema(value)).toBe(false)
    }
  })

  test('copies each shipped schema without its runtime metadata', () => {
    for (const spec of buildToolSpecs()) {
      const plain = toPlainSchemaSpec(spec)
      expect(plain.inputSchema).not.toBe(spec.inputSchema)
      expect(plain.inputSchema).toEqual(
        JSON.parse(JSON.stringify(spec.inputSchema)),
      )
      expect(plain.handler).toBe(spec.handler)
    }
  })

  test('rejects schemas whose serialized shape is not an object schema', () => {
    const [spec] = buildToolSpecs()
    if (!spec) {
      throw new Error('Expected at least one shipped tool')
    }
    expect(() =>
      toPlainSchemaSpec({
        ...spec,
        inputSchema: { type: 'object', toJSON: () => null },
      }),
    ).toThrow()
  })

  test('rejects primitive and array chunk manifests', () => {
    expect(isChunkedManifest({ chunks: ['Qexample'] })).toBe(true)
    for (const value of [null, undefined, [], 'manifest', 1, false]) {
      expect(isChunkedManifest(value)).toBe(false)
    }
  })
})
