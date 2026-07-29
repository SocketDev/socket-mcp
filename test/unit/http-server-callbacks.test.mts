/**
 * @file The HTTP transport's error sinks. `startHttpServer` wires the MCP
 *   handler's `onerror`, the Node adapter's `onerror`, and the route-failure
 *   fallback to these named functions, so each is asserted directly rather
 *   than by forcing a mid-response socket abort.
 */

import { describe, expect, test, vi } from 'vitest'

import {
  createRouteFailureHandler,
  handleMcpAdapterError,
  handleMcpHandlerError,
} from '../../lib/http-server.ts'
import { logger } from '../../lib/logger.ts'
import { makeRes } from './http-server-fixtures.mts'

describe('handleMcpHandlerError', () => {
  test('reports a failed exchange through the logger', () => {
    const errors = vi.spyOn(logger, 'error').mockImplementation(() => logger)
    handleMcpHandlerError(new Error('tool blew up'))
    expect(errors).toHaveBeenCalledWith('MCP request failed: tool blew up')
    errors.mockRestore()
  })
})

describe('handleMcpAdapterError', () => {
  test('reports an adapter failure through the logger', () => {
    const errors = vi.spyOn(logger, 'error').mockImplementation(() => logger)
    handleMcpAdapterError(new Error('socket hung up'))
    expect(errors).toHaveBeenCalledWith('MCP adapter failed: socket hung up')
    errors.mockRestore()
  })
})

describe('createRouteFailureHandler', () => {
  test('answers 500 when nothing has been written yet', () => {
    const errors = vi.spyOn(logger, 'error').mockImplementation(() => logger)
    const { captured, res } = makeRes()

    createRouteFailureHandler(res)(new Error('routing blew up'))

    expect(errors).toHaveBeenCalledWith(
      'Unhandled request failure: routing blew up',
    )
    expect(captured.statusCode).toBe(500)
    expect(JSON.parse(captured.body!)).toEqual({
      jsonrpc: '2.0',
      error: { code: -32_603, message: 'Internal server error' },
    })
    errors.mockRestore()
  })

  test('closes the response when the status is already committed', () => {
    const errors = vi.spyOn(logger, 'error').mockImplementation(() => logger)
    const { captured, res } = makeRes({ headersSent: true })

    createRouteFailureHandler(res)(new Error('routing blew up mid-stream'))

    // The status line is already on the wire, so the only move left is
    // closing the response — no second status, no body.
    expect(captured.statusCode).toBeUndefined()
    expect(captured.body).toBeUndefined()
    errors.mockRestore()
  })
})
