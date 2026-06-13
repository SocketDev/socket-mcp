import { Type } from '@sinclair/typebox'

import { errorMessage } from '@socketsecurity/lib/errors'

import { fetchAlerts } from './alerts.ts'
import { logger } from './logger.ts'
import {
  AUTH_REQUIRED_MSG,
  authRequiredResult,
  resolveScopedAuthToken,
  SOCKET_API_BASE_URL,
} from './server.ts'
import type { ToolSpec } from './tool-types.ts'
import { VERSION } from './version.ts'

export interface AlertsArgs {
  org_slug: string
  severity?: string | undefined
  status?: 'open' | 'cleared' | undefined
  category?: string | undefined
  artifact_type?: string | undefined
  artifact_name?: string | undefined
  alert_type?: string | undefined
  repo_slug?: string | undefined
  per_page?: number | undefined
  cursor?: string | undefined
}

const alertsInputSchema = Type.Object({
  org_slug: Type.String({
    description:
      'Organization slug, e.g. "my-org" (use the `organizations` tool to discover this)',
  }),
  severity: Type.Optional(
    Type.String({
      description:
        'Comma-separated severities to include: subset of low,medium,high,critical',
    }),
  ),
  status: Type.Optional(
    Type.Union([Type.Literal('open'), Type.Literal('cleared')], {
      description: 'Filter to open or cleared alerts',
    }),
  ),
  category: Type.Optional(
    Type.String({
      description:
        'Comma-separated categories: subset of supplyChainRisk,maintenance,quality,license,vulnerability',
    }),
  ),
  artifact_type: Type.Optional(
    Type.String({
      description:
        'Comma-separated ecosystems: subset of npm,pypi,gem,maven,golang,nuget,cargo,chrome,openvsx',
    }),
  ),
  artifact_name: Type.Optional(
    Type.String({ description: 'Filter to a specific package name' }),
  ),
  alert_type: Type.Optional(
    Type.String({
      description:
        'Comma-separated Socket alert types (e.g. "usesEval,unmaintained")',
    }),
  ),
  repo_slug: Type.Optional(
    Type.String({ description: 'Comma-separated repo slugs' }),
  ),
  per_page: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 5000,
      description: 'Results per page (default 100, max 5000)',
    }),
  ),
  cursor: Type.Optional(
    Type.String({
      description:
        "Pagination cursor — the `endCursor` from a previous response's metadata",
    }),
  ),
})

export function defineAlertsTool(): ToolSpec {
  return {
    name: 'alerts',
    title: 'List Alerts Tool',
    description:
      "List the latest security alerts for a Socket organization with the `alerts` tool. Requires `org_slug` — call the `organizations` tool first if you don't have it. Supports filtering by severity, category, status, artifact type/name, alert type, and repo. Use this to surface supply-chain, vulnerability, quality, license, and maintenance issues across the org's monitored packages. Results are paginated — pass the previous response's `endCursor` as `cursor` to fetch the next page.",
    inputSchema: alertsInputSchema,
    annotations: { readOnlyHint: true },
    async handler(rawArgs, extra) {
      const args = rawArgs as unknown as AlertsArgs
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
      const accessToken = resolveScopedAuthToken(extra.authInfo?.token)
      if (!accessToken) {
        logger.error('alerts: ' + AUTH_REQUIRED_MSG)
        return authRequiredResult()
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
            ...(args.artifact_type ? { artifactType: args.artifact_type } : {}),
            ...(args.artifact_name ? { artifactName: args.artifact_name } : {}),
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
        const errorMsg = `Error fetching alerts for ${args.org_slug}: ${errorMessage(e)}`
        logger.error(errorMsg)
        return {
          content: [{ type: 'text', text: errorMsg }],
          isError: true,
        }
      }
    },
  }
}
