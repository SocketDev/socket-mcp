import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { errorMessage } from '@socketsecurity/lib/errors'

import { getStaticApiKey } from './depscore-tool.ts'
import { getSocketApiUrl } from './env.ts'
import { logger } from './logger.ts'
import { fetchOrganizations } from './organizations.ts'
import { VERSION } from './version.ts'

const SOCKET_API_BASE_URL = getSocketApiUrl() || 'https://api.socket.dev'

const AUTH_REQUIRED_MSG =
  'Authentication is required. Configure SOCKET_API_TOKEN (or a legacy alias) for stdio mode or connect through OAuth-enabled HTTP mode.'

export function registerOrganizationsTool(srv: McpServer): void {
  srv.registerTool(
    'organizations',
    {
      title: 'List Organizations Tool',
      description:
        'List the Socket organizations the authenticated user belongs to with the `organizations` tool. Use this to discover the `org_slug` values needed by other org-scoped tools (e.g. `alerts`, `threat_feed`), or when the user asks which organizations they have access to.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
      },
    },
    async (args, extra) => {
      void args
      logger.info({ tool: 'organizations' }, 'tool invoked')
      const accessToken = extra.authInfo?.token || getStaticApiKey()
      if (!accessToken) {
        return {
          content: [{ type: 'text', text: AUTH_REQUIRED_MSG }],
          isError: true,
        }
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
  )
}
