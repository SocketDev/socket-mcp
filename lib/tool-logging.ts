import { errorMessage } from '@socketsecurity/lib/errors/message'

import { debug, logger } from './logger.ts'
import {
  emitAuditEvent,
  extractResources,
  maskArgs,
  newRequestId,
  tokenIdentity,
} from './tool-audit.ts'
import type { ToolCallResult, ToolHandlerExtra } from './tool-types.ts'

/**
 * Wrap a tool handler so every invocation logs its args + response + emits a
 * structured JSON audit entry (SUS-18 / TPSF-2598). Request args + successful
 * responses log via `debug()` (suppressed unless SOCKET_DEBUG is set); error
 * responses and thrown errors always log at `error` so failures surface even in
 * a normal run. The audit entry (timestamp, identity, request ID, tool,
 * status, resources, masked args) is written to the append-only JSONL store in
 * `tool-audit.ts`. The access token rides on `extra.authInfo` and is never
 * logged raw — the audit entry carries a truncated SHA-256 hash.
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
    const requestId = newRequestId()
    const identity = tokenIdentity(extra?.authInfo?.token)
    const masked = maskArgs(args)
    const resources = extractResources(args)
    debug({ tool: name, args: masked }, 'tool call')
    try {
      const result = await handler(args, extra)
      const status = result?.isError ? 'failure' : 'success'
      emitAuditEvent({
        args: masked,
        identity,
        requestId,
        resources,
        status,
        timestamp: new Date().toISOString(),
        tool: name,
      })
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
      emitAuditEvent({
        args: masked,
        identity,
        requestId,
        resources,
        status: 'failure',
        timestamp: new Date().toISOString(),
        tool: name,
      })
      throw e
    }
  }
}
