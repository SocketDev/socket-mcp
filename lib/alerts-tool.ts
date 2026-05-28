import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { getSocketApiUrl } from './env.ts'
import { fetchAlerts } from './alerts.ts'
import { getStaticApiKey } from './depscore-tool.ts'
import { logger } from './logger.ts'
import { VERSION } from './version.ts'

const SOCKET_API_BASE_URL =
  getSocketApiUrl() || 'https://api.socket.dev'

const AUTH_REQUIRED_MSG =
  'Authentication is required. Configure SOCKET_API_TOKEN (or a legacy alias) for stdio mode or connect through OAuth-enabled HTTP mode.'

export function registerAlertsTool(srv: McpServer): void {
  srv.registerTool(
    'alerts',
    {
      title: 'List Alerts Tool',
      description:
        "List the latest security alerts for a Socket organization with the `alerts` tool. Requires `org_slug` — call the `organizations` tool first if you don't have it. Supports filtering by severity, category, status, artifact type/name, alert type, and repo. Use this to surface supply-chain, vulnerability, quality, license, and maintenance issues across the org's monitored packages. Results are paginated — pass the previous response's `endCursor` as `cursor` to fetch the next page.",
      inputSchema: {
        org_slug: z
          .string()
          .describe(
            'Organization slug, e.g. "my-org" (use the `organizations` tool to discover this)',
          ),
        severity: z
          .string()
          .optional()
          .describe(
            'Comma-separated severities to include: subset of low,medium,high,critical',
          ),
        status: z
          .enum(['open', 'cleared'])
          .optional()
          .describe('Filter to open or cleared alerts'),
        category: z
          .string()
          .optional()
          .describe(
            'Comma-separated categories: subset of supplyChainRisk,maintenance,quality,license,vulnerability',
          ),
        artifact_type: z
          .string()
          .optional()
          .describe(
            'Comma-separated ecosystems: subset of npm,pypi,gem,maven,golang,nuget,cargo,chrome,openvsx',
          ),
        artifact_name: z
          .string()
          .optional()
          .describe('Filter to a specific package name'),
        alert_type: z
          .string()
          .optional()
          .describe(
            'Comma-separated Socket alert types (e.g. "usesEval,unmaintained")',
          ),
        repo_slug: z.string().optional().describe('Comma-separated repo slugs'),
        per_page: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .optional()
          .describe('Results per page (default 100, max 5000)'),
        cursor: z
          .string()
          .optional()
          .describe(
            "Pagination cursor — the `endCursor` from a previous response's metadata",
          ),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async (args, extra) => {
      logger.info(
        {
          tool: 'alerts',
          org_slug: args.org_slug,
          filters: {
            severity: args.severity,
            status: args.status,
            category: args.category,
            artifact_type: args.artifact_type,
            alert_type: args.alert_type,
          },
        },
        'tool invoked',
      )
      const accessToken = extra.authInfo?.token || getStaticApiKey()
      if (!accessToken) {
        return {
          content: [{ type: 'text', text: AUTH_REQUIRED_MSG }],
          isError: true,
        }
      }
      try {
        const data = await fetchAlerts({
          baseUrl: SOCKET_API_BASE_URL,
          orgSlug: args.org_slug,
          userAgent: `socket-mcp/${VERSION}`,
          authToken: accessToken,
          filters: {
            ...(args.severity ? { severity: args.severity } : {}),
            ...(args.status ? { status: args.status } : {}),
            ...(args.category ? { category: args.category } : {}),
            ...(args.artifact_type
              ? { artifactType: args.artifact_type }
              : {}),
            ...(args.artifact_name
              ? { artifactName: args.artifact_name }
              : {}),
            ...(args.alert_type ? { alertType: args.alert_type } : {}),
            ...(args.repo_slug ? { repoSlug: args.repo_slug } : {}),
            perPage: args.per_page ?? 100,
            ...(args.cursor ? { cursor: args.cursor } : {}),
          },
        })
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        }
      } catch (e) {
        const error = e as Error
        const errorMsg = `Error fetching alerts for ${args.org_slug}: ${error.message}`
        logger.error(errorMsg)
        return {
          content: [{ type: 'text', text: errorMsg }],
          isError: true,
        }
      }
    },
  )
}
