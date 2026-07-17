import { errorMessage } from '@socketsecurity/lib/errors/message'

import { debug, logger } from './logger.ts'
import type { ToolCallResult, ToolHandlerExtra } from './tool-types.ts'

/**
 * Wrap a tool handler so every invocation logs its args + response. Request
 * args + successful responses log via `debug()` (suppressed unless SOCKET_DEBUG
 * is set); error responses and thrown errors always log at `error` so failures
 * surface even in a normal run. Args carry no secrets — the access token rides
 * on `extra.authInfo`, which is never logged.
 *
 * Applied centrally inside `dispatchToolCall` (server.ts) so every tool gets
 * the same treatment without each handler repeating the logging.
 */
export type ToolHandler = (
  args: Record<string, unknown>,
  extra: ToolHandlerExtra,
) => Promise<ToolCallResult> | ToolCallResult

export function withToolLogging(
  name: string,
  handler: ToolHandler,
): ToolHandler {
  return async (args, extra) => {
    debug({ tool: name, args }, 'tool call')
    try {
      const result = await handler(args, extra)
      if (result?.isError) {
        logger.error(
          { tool: name, response: result.content },
          'tool call returned error',
        )
      } else {
        debug({ tool: name, response: result?.content }, 'tool result')
      }
      return result
    } catch (e) {
      logger.error({ tool: name, error: errorMessage(e) }, 'tool call threw')
      throw e
    }
  }
}
