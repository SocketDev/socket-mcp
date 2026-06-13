import { Type } from '@sinclair/typebox'

import { errorMessage } from '@socketsecurity/lib/errors'

import { logger } from './logger.ts'
import {
  AUTH_REQUIRED_MSG,
  authRequiredResult,
  resolveScopedAuthToken,
  SOCKET_API_BASE_URL,
} from './server.ts'
import { fetchThreatFeed } from './threat-feed.ts'
import type { ToolSpec } from './tool-types.ts'
import { VERSION } from './version.ts'

export interface ThreatFeedArgs {
  org_slug: string
  filter?: string | undefined
  ecosystem?: string | undefined
  name?: string | undefined
  version?: string | undefined
  is_human_reviewed?: boolean | undefined
  sort?: 'id' | 'created_at' | 'updated_at' | undefined
  direction?: 'asc' | 'desc' | undefined
  updated_after?: string | undefined
  created_after?: string | undefined
  per_page?: number | undefined
  cursor?: string | undefined
}

const threatFeedInputSchema = Type.Object({
  org_slug: Type.String({
    description:
      'Organization slug, e.g. "my-org" (use the `organizations` tool to discover this)',
  }),
  filter: Type.Optional(
    Type.String({
      description:
        'Threat category filter (default `mal`). Common values: `mal` (malware), `vuln`, `typ` (typosquat), `obf` (obfuscated), `mjo`, `kes`, `spy`, `ano`, `ucf`, `ptp`, `ual`',
    }),
  ),
  ecosystem: Type.Optional(
    Type.String({
      description:
        'Ecosystem filter, e.g. npm, pypi, gem, maven, golang, nuget, cargo, chrome, openvsx, vscode, huggingface',
    }),
  ),
  name: Type.Optional(Type.String({ description: 'Filter by package name' })),
  version: Type.Optional(
    Type.String({ description: 'Filter by package version' }),
  ),
  is_human_reviewed: Type.Optional(
    Type.Boolean({
      description: 'Only return human-reviewed items (default false)',
    }),
  ),
  sort: Type.Optional(
    Type.Union(
      [
        Type.Literal('id'),
        Type.Literal('created_at'),
        Type.Literal('updated_at'),
      ],
      { description: 'Sort field (default `updated_at`)' },
    ),
  ),
  direction: Type.Optional(
    Type.Union([Type.Literal('asc'), Type.Literal('desc')], {
      description: 'Sort direction (default `desc`)',
    }),
  ),
  updated_after: Type.Optional(
    Type.String({
      description: 'ISO timestamp; only return items updated after this',
    }),
  ),
  created_after: Type.Optional(
    Type.String({
      description: 'ISO timestamp; only return items created after this',
    }),
  ),
  per_page: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 100,
      description: 'Results per page (default 30, max 100)',
    }),
  ),
  cursor: Type.Optional(
    Type.String({
      description:
        'Pagination cursor — the `nextPageCursor` from a previous response',
    }),
  ),
})

export function defineThreatFeedTool(): ToolSpec {
  return {
    name: 'threat_feed',
    title: 'Threat Feed Tool',
    description:
      "Look up items in the Socket organization threat feed with the `threat_feed` tool. Requires `org_slug` — call the `organizations` tool first if you don't have it. Returns recently flagged packages (malware, typosquats, obfuscated code, etc.) along with a `nextPageCursor` for pagination. Use `filter` to narrow the threat category (default `mal` for malware), `ecosystem` to scope to a registry, or `name`/`version` to look up a specific package. Pass the previous response's cursor as `cursor` to fetch the next page.",
    inputSchema: threatFeedInputSchema,
    annotations: { readOnlyHint: true },
    async handler(rawArgs, extra) {
      const args = rawArgs as unknown as ThreatFeedArgs
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
      const accessToken = resolveScopedAuthToken(extra.authInfo?.token)
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
  }
}
