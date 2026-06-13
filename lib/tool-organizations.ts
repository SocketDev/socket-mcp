import { Type } from '@sinclair/typebox'

import { errorMessage } from '@socketsecurity/lib/errors'

import { logger } from './logger.ts'
import { fetchOrganizations } from './organizations.ts'
import {
  AUTH_REQUIRED_MSG,
  authRequiredResult,
  resolveAuthToken,
  SOCKET_API_BASE_URL,
} from './server.ts'
import type { ToolSpec } from './tool-types.ts'
import { VERSION } from './version.ts'

export function defineOrganizationsTool(): ToolSpec {
  return {
    name: 'organizations',
    title: 'List Organizations Tool',
    description:
      'List the Socket organizations the authenticated user belongs to with the `organizations` tool. Use this to discover the `org_slug` values needed by other org-scoped tools (e.g. `alerts`, `threat_feed`), or when the user asks which organizations they have access to.',
    inputSchema: Type.Object({}),
    annotations: { readOnlyHint: true },
    async handler(_args, extra) {
      logger.info({ tool: 'organizations' }, 'tool invoked')
      const accessToken = resolveAuthToken(extra.authInfo?.token)
      if (!accessToken) {
        logger.error('organizations: ' + AUTH_REQUIRED_MSG)
        return authRequiredResult()
      }
      try {
        const data = await fetchOrganizations({
          baseUrl: SOCKET_API_BASE_URL,
          userAgent: `socket-mcp/${VERSION}`,
          authToken: accessToken,
        })
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        }
      } catch (e) {
        const errorMsg = `Error fetching organizations: ${errorMessage(e)}`
        logger.error(errorMsg)
        return {
          content: [{ type: 'text', text: errorMsg }],
          isError: true,
        }
      }
    },
  }
}
