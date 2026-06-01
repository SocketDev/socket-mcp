import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { errorMessage } from '@socketsecurity/lib/errors'
import { z } from 'zod'

import { logger } from './logger.ts'
import {
  AUTH_REQUIRED_MSG,
  SOCKET_API_BASE_URL,
  authRequiredResult,
  resolveAuthToken,
} from './server.ts'
import { fetchThreatFeed } from './threat-feed.ts'
import { VERSION } from './version.ts'

export function registerThreatFeedTool(srv: McpServer): void {
  srv.registerTool(
    'threat_feed',
    {
      title: 'Threat Feed Tool',
      description:
        "Look up items in the Socket organization threat feed with the `threat_feed` tool. Requires `org_slug` — call the `organizations` tool first if you don't have it. Returns recently flagged packages (malware, typosquats, obfuscated code, etc.) along with a `nextPageCursor` for pagination. Use `filter` to narrow the threat category (default `mal` for malware), `ecosystem` to scope to a registry, or `name`/`version` to look up a specific package. Pass the previous response's cursor as `cursor` to fetch the next page.",
      inputSchema: {
        org_slug: z
          .string()
          .describe(
            'Organization slug, e.g. "my-org" (use the `organizations` tool to discover this)',
          ),
        filter: z
          .string()
          .optional()
          .describe(
            'Threat category filter (default `mal`). Common values: `mal` (malware), `vuln`, `typ` (typosquat), `obf` (obfuscated), `mjo`, `kes`, `spy`, `ano`, `ucf`, `ptp`, `ual`',
          ),
        ecosystem: z
          .string()
          .optional()
          .describe(
            'Ecosystem filter, e.g. npm, pypi, gem, maven, golang, nuget, cargo, chrome, openvsx, vscode, huggingface',
          ),
        name: z.string().optional().describe('Filter by package name'),
        version: z.string().optional().describe('Filter by package version'),
        is_human_reviewed: z
          .boolean()
          .optional()
          .describe('Only return human-reviewed items (default false)'),
        sort: z
          .enum(['id', 'created_at', 'updated_at'])
          .optional()
          .describe('Sort field (default `updated_at`)'),
        direction: z
          .enum(['asc', 'desc'])
          .optional()
          .describe('Sort direction (default `desc`)'),
        updated_after: z
          .string()
          .optional()
          .describe('ISO timestamp; only return items updated after this'),
        created_after: z
          .string()
          .optional()
          .describe('ISO timestamp; only return items created after this'),
        per_page: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Results per page (default 30, max 100)'),
        cursor: z
          .string()
          .optional()
          .describe(
            'Pagination cursor — the `nextPageCursor` from a previous response',
          ),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async (args, extra) => {
      logger.info(
        {
          tool: 'threat_feed',
          org_slug: args.org_slug,
          filters: {
            filter: args.filter,
            ecosystem: args.ecosystem,
            name: args.name,
            version: args.version,
          },
        },
        'tool invoked',
      )
      const accessToken = resolveAuthToken(extra.authInfo?.token)
      if (!accessToken) {
        logger.error('threat_feed: ' + AUTH_REQUIRED_MSG)
        return authRequiredResult()
      }
      try {
        const data = await fetchThreatFeed({
          baseUrl: SOCKET_API_BASE_URL,
          orgSlug: args.org_slug,
          userAgent: `socket-mcp/${VERSION}`,
          authToken: accessToken,
          filters: {
            ...(args.filter ? { filter: args.filter } : {}),
            ...(args.ecosystem ? { ecosystem: args.ecosystem } : {}),
            ...(args.name ? { name: args.name } : {}),
            ...(args.version ? { version: args.version } : {}),
            ...(typeof args.is_human_reviewed === 'boolean'
              ? { isHumanReviewed: args.is_human_reviewed }
              : {}),
            ...(args.sort ? { sort: args.sort } : {}),
            ...(args.direction ? { direction: args.direction } : {}),
            ...(args.updated_after ? { updatedAfter: args.updated_after } : {}),
            ...(args.created_after ? { createdAfter: args.created_after } : {}),
            ...(typeof args.per_page === 'number'
              ? { perPage: args.per_page }
              : {}),
            ...(args.cursor ? { cursor: args.cursor } : {}),
          },
        })
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        }
      } catch (e) {
        const errorMsg = `Error fetching threat feed for ${args.org_slug}: ${errorMessage(e)}`
        logger.error(errorMsg)
        return {
          content: [{ type: 'text', text: errorMsg }],
          isError: true,
        }
      }
    },
  )
}
