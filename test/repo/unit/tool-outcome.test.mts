import { describe, expect, test } from 'vitest'

import {
  classifyToolOutcome,
  markToolOutcome,
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
})
