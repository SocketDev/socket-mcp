import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { describe, expect, test } from 'vitest'

import { withToolLogging } from '../lib/tool-logging.ts'

// Minimal McpServer stand-in: captures the handler registerTool receives so
// the test can invoke the logging-wrapped version directly.
function makeFakeServer(): {
  srv: McpServer
  getHandler: () => (...args: unknown[]) => unknown
} {
  let captured: (...args: unknown[]) => unknown = () => undefined
  const srv = {
    registerTool(_name: string, _config: unknown, handler: unknown) {
      captured = handler as (...args: unknown[]) => unknown
    },
  } as unknown as McpServer
  return { srv, getHandler: () => captured }
}

describe('withToolLogging', () => {
  test('passes a successful result through unchanged', async () => {
    const fake = makeFakeServer()
    const wrapped = withToolLogging(fake.srv)
    const ok = { content: [{ type: 'text', text: 'hi' }] }
    wrapped.registerTool('demo', {} as never, (async () => ok) as never)
    const result = await fake.getHandler()({ foo: 1 }, { authInfo: {} })
    expect(result).toBe(ok)
  })

  test('rethrows when the handler throws', async () => {
    const fake = makeFakeServer()
    const wrapped = withToolLogging(fake.srv)
    wrapped.registerTool(
      'boom',
      {} as never,
      (async () => {
        throw new Error('kaboom')
      }) as never,
    )
    await expect(fake.getHandler()({}, {})).rejects.toThrow(/kaboom/)
  })

  test('passes an isError result through (logged, not thrown)', async () => {
    const fake = makeFakeServer()
    const wrapped = withToolLogging(fake.srv)
    const errResult = {
      content: [{ type: 'text', text: 'nope' }],
      isError: true,
    }
    wrapped.registerTool('err', {} as never, (async () => errResult) as never)
    const result = await fake.getHandler()({}, {})
    expect(result).toBe(errResult)
  })
})
