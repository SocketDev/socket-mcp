import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { errorMessage } from '@socketsecurity/lib/errors'

import { debug, logger } from './logger.ts'

interface ToolResult {
  content?: unknown | undefined
  isError?: boolean | undefined
}

// Wrap srv.registerTool so every tool logs its invocation args and its
// response. Request args + successful responses log via debug() (suppressed
// unless SOCKET_DEBUG is set); error responses and thrown errors always log at
// `error` so failures surface even in a normal run. Args carry no secrets —
// the access token rides on `extra.authInfo`, which is never logged here.
//
// Applied centrally in createConfiguredServer so all tools get the same
// treatment without each handler repeating the logging.
export function withToolLogging(srv: McpServer): McpServer {
  const original = srv.registerTool.bind(srv) as McpServer['registerTool']
  srv.registerTool = ((
    name: string,
    config: unknown,
    handler: (...handlerArgs: unknown[]) => unknown,
  ) => {
    const wrapped = async (...callArgs: unknown[]): Promise<unknown> => {
      // 2-arg handlers (no input schema) get only `extra`; 3-arg form here
      // means the first call arg is the tool's parsed input.
      const args = callArgs.length > 1 ? callArgs[0] : undefined
      debug({ tool: name, args }, 'tool call')
      try {
        const result = (await handler(...callArgs)) as ToolResult
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
    return original(
      name,
      config as Parameters<McpServer['registerTool']>[1],
      wrapped as Parameters<McpServer['registerTool']>[2],
    )
  }) as McpServer['registerTool']
  return srv
}
