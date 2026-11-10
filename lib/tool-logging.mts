import { debug, logger } from './logger.mts'
import type { ToolCallResult, ToolHandlerExtra } from './tool-types.mts'

/**
 * Wrap a tool handler to log tool names for local diagnostics. Audit records
 * are emitted at the MCP dispatch boundary where SDK request context is known.
 *
 * Applied centrally inside `dispatchToolCall` (server.mts) so every tool gets
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
    debug({ tool: name }, 'tool call')
    try {
      const result = await handler(args, extra)
      if (result?.isError) {
        logger.error({ tool: name }, 'tool call returned error')
      } else {
        debug({ tool: name }, 'tool result')
      }
      return result
    } catch (error) {
      logger.error({ tool: name }, 'tool call threw')
      throw error
    }
  }
}
