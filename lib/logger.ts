/**
 * @file MCP server logger. Wraps `@socketsecurity/lib`'s default logger so the
 *   rest of the codebase uses the fleet-canonical surface (`logger.info` /
 *   `logger.error` / etc.). Replaced an earlier pino-based implementation
 *   during the bundle migration — pino's transport worker threads aren't
 *   compatible with a single-file CJS bundle.
 */

import { getDefaultLogger } from '@socketsecurity/lib/logger/default'

export const logger = getDefaultLogger()
