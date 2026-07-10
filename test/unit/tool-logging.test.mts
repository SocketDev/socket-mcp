import { describe, expect, test } from 'vitest'

import { withToolLogging } from '../../lib/tool-logging.ts'

describe('withToolLogging', () => {
  test('passes a successful result through unchanged', async () => {
    const ok = { content: [{ type: 'text' as const, text: 'hi' }] }
    const wrapped = withToolLogging('demo', async () => ok)
    const result = await wrapped({ foo: 1 }, { authInfo: {} })
    expect(result).toBe(ok)
  })

  test('rethrows when the handler throws', async () => {
    const wrapped = withToolLogging('boom', async () => {
      throw new Error('kaboom')
    })
    await expect(wrapped({}, {})).rejects.toThrow(/kaboom/)
  })

  test('passes an isError result through (logged, not thrown)', async () => {
    const errResult = {
      content: [{ type: 'text' as const, text: 'nope' }],
      isError: true,
    }
    const wrapped = withToolLogging('err', async () => errResult)
    const result = await wrapped({}, {})
    expect(result).toBe(errResult)
  })
})
