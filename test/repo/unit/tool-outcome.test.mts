import { describe, expect, test } from 'vitest'

import {
  classifyToolFailure,
  classifyUpstreamFailure,
  classifyUpstreamHttpError,
  classifyToolOutcome,
  errorCode,
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

  test('records why an upstream call failed without changing wire fields', () => {
    const result = { content: [], isError: true }
    const error = new UpstreamHttpError(502, 'raw upstream body')
    expect(markUpstreamHttpOutcome(result, error)).toBe(result)
    expect(classifyToolOutcome(result)).toBe('failure')
    expect(classifyToolFailure(result)).toEqual({
      cause: 'upstream_5xx',
      error,
      status: 502,
    })
    expect(JSON.stringify(result)).toBe('{"content":[],"isError":true}')
    expect(classifyToolFailure({ content: [], isError: true })).toBeUndefined()
  })
})

describe('upstream failure causes', () => {
  test('splits HTTP statuses into denied, client and server answers', () => {
    expect(classifyUpstreamFailure(new UpstreamHttpError(401, 'x'))).toBe(
      'upstream_denied',
    )
    expect(classifyUpstreamFailure(new UpstreamHttpError(403, 'x'))).toBe(
      'upstream_denied',
    )
    expect(classifyUpstreamFailure(new UpstreamHttpError(404, 'x'))).toBe(
      'upstream_4xx',
    )
    expect(classifyUpstreamFailure(new UpstreamHttpError(429, 'x'))).toBe(
      'upstream_4xx',
    )
    expect(classifyUpstreamFailure(new UpstreamHttpError(500, 'x'))).toBe(
      'upstream_5xx',
    )
    expect(classifyUpstreamFailure(new UpstreamHttpError(503, 'x'))).toBe(
      'upstream_5xx',
    )
  })

  test('reads network and timeout codes through wrapped causes', () => {
    const refused = Object.assign(new Error('connect refused'), {
      code: 'ECONNREFUSED',
    })
    const wrapped = new Error('file-list request failed', {
      cause: new Error('GET failed', { cause: refused }),
    })
    expect(classifyUpstreamFailure(refused)).toBe('network')
    expect(classifyUpstreamFailure(wrapped)).toBe('network')
    expect(errorCode(wrapped)).toBe('ECONNREFUSED')
    expect(
      classifyUpstreamFailure(
        Object.assign(new Error('connect'), { code: 'ETIMEDOUT' }),
      ),
    ).toBe('timeout')
    // The shared HTTP client's own timeout carries no code.
    expect(
      classifyUpstreamFailure(
        new Error('GET request timed out after 30000ms: https://example.test/'),
      ),
    ).toBe('timeout')
  })

  test('calls anything else an exception', () => {
    expect(classifyUpstreamFailure(new SyntaxError('Unexpected token'))).toBe(
      'exception',
    )
    expect(classifyUpstreamFailure('not an error')).toBe('exception')
    expect(errorCode(new Error('no code'))).toBeUndefined()
  })
})
