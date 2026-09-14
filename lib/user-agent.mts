import {
  buildUserAgent,
  chainUserAgents,
} from '@socketsecurity/lib/http-request/user-agent'

import { VERSION } from './version.mts'

export function buildMcpUserAgent(
  clientUserAgent?: string | undefined,
): string {
  return buildUserAgent(
    { name: 'socket-mcp', version: VERSION },
    clientUserAgent,
  )
}

export function prependMcpUserAgent(
  identity: string,
  userAgent?: string | undefined,
): string {
  return chainUserAgents([identity, userAgent ?? buildMcpUserAgent()])
}

export function resolveMcpUserAgent(userAgent?: string | undefined): string {
  return userAgent ?? buildMcpUserAgent()
}
