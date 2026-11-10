import { describe, expect, test } from 'vitest'

import {
  classifyUpstreamHttpError,
  classifyToolOutcome,
  markToolOutcome,
  markUpstreamHttpOutcome,
  UpstreamHttpError,
} from '../../../lib/tool-outcome.mts'

describe('tool result outcomes', () => {
  test('classifies ordinary protocol success and error results', () => {
    expect(classifyToolOutcome({ content: [] })).toBe('success')
    expect(classifyToolOutcome({ content: [], isError: false })).toBe('success')
    expect(classifyToolOutcome({ content: [], isError: true })).toBe('failure')
  })

  test('marks denied and invalid outcomes without changing the result object', () => {
    const denied = {
      content: [{ type: 'text', text: 'unrelated response wording' }],
      isError: true,
    }
    const invalid = {
      content: [{ type: 'text', text: 'ordinary validation details' }],
      isError: true,
    }
    const deniedContent = denied.content
    const invalidContent = invalid.content

    expect(markToolOutcome(denied, 'denied')).toBe(denied)
    expect(markToolOutcome(invalid, 'invalid')).toBe(invalid)
    expect(classifyToolOutcome(denied)).toBe('denied')
    expect(classifyToolOutcome(invalid)).toBe('invalid')
    expect(denied.content).toBe(deniedContent)
    expect(invalid.content).toBe(invalidContent)
    expect(JSON.stringify(denied)).toBe(
      '{"content":[{"type":"text","text":"unrelated response wording"}],"isError":true}',
    )
    expect(JSON.stringify(invalid)).toBe(
      '{"content":[{"type":"text","text":"ordinary validation details"}],"isError":true}',
    )
  })

  test('does not infer a denial from response wording', () => {
    expect(
      classifyToolOutcome({
        content: [{ type: 'text', text: 'access denied' }],
        isError: true,
      }),
    ).toBe('failure')
  })

  test('classifies only typed upstream 401 and 403 statuses as denied', () => {
    expect(
      classifyUpstreamHttpError(new UpstreamHttpError(401, 'anything')),
    ).toBe('denied')
    expect(
      classifyUpstreamHttpError(new UpstreamHttpError(403, 'anything')),
    ).toBe('denied')
    expect(
      classifyUpstreamHttpError(new UpstreamHttpError(400, 'unauthorized')),
    ).toBe('failure')
    expect(
      classifyUpstreamHttpError(new UpstreamHttpError(500, 'forbidden')),
    ).toBe('failure')
    expect(
      classifyUpstreamHttpError(new Error('upstream 401 unauthorized')),
    ).toBe('failure')
    expect(
      classifyUpstreamHttpError({ status: 403, message: 'access denied' }),
    ).toBe('failure')
  })

  test('marks an upstream denial without changing wire fields', () => {
    const result = {
      content: [{ type: 'text', text: 'original upstream detail' }],
      isError: true,
    }
    expect(
      markUpstreamHttpOutcome(result, new UpstreamHttpError(403, 'raw')),
    ).toBe(result)
    expect(classifyToolOutcome(result)).toBe('denied')
    expect(JSON.stringify(result)).toBe(
      '{"content":[{"type":"text","text":"original upstream detail"}],"isError":true}',
    )
  })
})
