/**
 * @file MCP server logger. Wraps `@socketsecurity/lib`'s default logger so the
 *   rest of the codebase uses the fleet-canonical surface (`logger.info` /
 *   `logger.error` / etc.). Replaced an earlier pino-based implementation
 *   during the bundle migration — pino's transport worker threads aren't
 *   compatible with a single-file CJS bundle.
 */

import { envAsBoolean } from '@socketsecurity/lib/env/boolean'
import { getSocketDebug } from '@socketsecurity/lib/env/socket'
import { getDefaultLogger } from '@socketsecurity/lib/logger/default'

export const logger = getDefaultLogger()

const debugEnabled = envAsBoolean(getSocketDebug())

// Verbose request/cache trace, suppressed unless SOCKET_DEBUG is set. The fleet
// logger has no debug level, so this preserves the prior pino default where
// debug output stayed quiet in normal operation.
export function debug(...args: unknown[]): void {
  if (debugEnabled) {
    logger.info(...args)
  }
}
