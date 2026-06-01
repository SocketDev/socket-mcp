import { httpRequest } from '@socketsecurity/lib/http-request/request'

import { buildJsonApiHeaders } from './http-helpers.ts'

export interface AlertsFilters {
  // Comma-separated subset of: low,medium,high,critical
  severity?: string | undefined
  // Single value: open | cleared
  status?: 'open' | 'cleared' | undefined
  // Comma-separated subset of: supplyChainRisk,maintenance,quality,license,vulnerability
  category?: string | undefined
  // Comma-separated ecosystems: npm,pypi,gem,maven,golang,nuget,cargo,chrome,openvsx
  artifactType?: string | undefined
  // Single package name to filter to
  artifactName?: string | undefined
  // Comma-separated Socket alert types (e.g. "usesEval,unmaintained")
  alertType?: string | undefined
  // Comma-separated repo slugs
  repoSlug?: string | undefined
  // 1..5000. The API caps at 5000 and defaults to 1000.
  perPage?: number | undefined
  // Pagination cursor from a previous response's endCursor
  cursor?: string | undefined
}

export interface FetchAlertsOptions {
  baseUrl: string
  orgSlug: string
  filters?: AlertsFilters | undefined
  userAgent?: string | undefined
  // Socket access token, sent as `Authorization: Bearer <token>` when set.
  authToken?: string | undefined
  extraHeaders?: Record<string, string> | undefined
}

/**
 * Map the curated `AlertsFilters` shape to the API's flat `filters.*` query
 * params. Only set values are included — undefined keys are skipped.
 */
export function buildAlertsQuery(
  filters: AlertsFilters | undefined,
  perPageFallback?: number,
): URLSearchParams {
  const params = new URLSearchParams()
  const f = filters ?? {}
  if (f.severity) {
    params.set('filters.alertSeverity', f.severity)
  }
  if (f.status) {
    params.set('filters.alertStatus', f.status)
  }
  if (f.category) {
    params.set('filters.alertCategory', f.category)
  }
  if (f.artifactType) {
    params.set('filters.artifactType', f.artifactType)
  }
  if (f.artifactName) {
    params.set('filters.artifactName', f.artifactName)
  }
  if (f.alertType) {
    params.set('filters.alertType', f.alertType)
  }
  if (f.repoSlug) {
    params.set('filters.repoSlug', f.repoSlug)
  }
  const perPage = f.perPage ?? perPageFallback
  if (typeof perPage === 'number') {
    params.set('per_page', String(perPage))
  }
  if (f.cursor) {
    params.set('startAfterCursor', f.cursor)
  }
  return params
}

/**
 * Fetch the latest alerts for an organization from `GET
 * /v0/orgs/{org_slug}/alerts`. Returns the parsed JSON body untouched.
 */
export async function fetchAlerts(
  options: FetchAlertsOptions,
): Promise<unknown> {
  const baseUrl = options.baseUrl.replace(/\/$/u, '')
  const qs = buildAlertsQuery(options.filters).toString()
  const url = `${baseUrl}/v0/orgs/${encodeURIComponent(options.orgSlug)}/alerts${qs ? `?${qs}` : ''}`

  const res = await httpRequest(url, { headers: buildJsonApiHeaders(options) })
  if (!res.ok) {
    throw new Error(`alerts endpoint ${res.status}: ${res.text()}`)
  }
  return res.json<unknown>()
}
