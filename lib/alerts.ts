export interface AlertsFilters {
  /** Comma-separated subset of: low,medium,high,critical */
  severity?: string
  /** Single value: open | cleared */
  status?: 'open' | 'cleared'
  /** Comma-separated subset of: supplyChainRisk,maintenance,quality,license,vulnerability */
  category?: string
  /** Comma-separated ecosystems: npm,pypi,gem,maven,golang,nuget,cargo,chrome,openvsx */
  artifactType?: string
  /** Single package name to filter to */
  artifactName?: string
  /** Comma-separated Socket alert types (e.g. "usesEval,unmaintained") */
  alertType?: string
  /** Comma-separated repo slugs */
  repoSlug?: string
  /** 1..5000. The API caps at 5000 and defaults to 1000. */
  perPage?: number
  /** Pagination cursor from a previous response's endCursor */
  cursor?: string
}

export interface FetchAlertsOptions {
  baseUrl: string
  orgSlug: string
  filters?: AlertsFilters
  fetchFn?: typeof fetch
  userAgent?: string
  /** Socket access token, sent as `Authorization: Bearer <token>` when set. */
  authToken?: string
  extraHeaders?: Record<string, string>
}

/**
 * Map the curated `AlertsFilters` shape to the API's flat `filters.*` query
 * params. Only set values are included — undefined keys are skipped.
 */
export function buildAlertsQuery (
  filters: AlertsFilters | undefined,
  perPageFallback?: number
): URLSearchParams {
  const params = new URLSearchParams()
  const f = filters ?? {}
  if (f.severity) params.set('filters.alertSeverity', f.severity)
  if (f.status) params.set('filters.alertStatus', f.status)
  if (f.category) params.set('filters.alertCategory', f.category)
  if (f.artifactType) params.set('filters.artifactType', f.artifactType)
  if (f.artifactName) params.set('filters.artifactName', f.artifactName)
  if (f.alertType) params.set('filters.alertType', f.alertType)
  if (f.repoSlug) params.set('filters.repoSlug', f.repoSlug)
  const perPage = f.perPage ?? perPageFallback
  if (typeof perPage === 'number') params.set('per_page', String(perPage))
  if (f.cursor) params.set('startAfterCursor', f.cursor)
  return params
}

/**
 * Fetch the latest alerts for an organization from
 * `GET /v0/orgs/{org_slug}/alerts`. Returns the parsed JSON body untouched.
 */
export async function fetchAlerts (
  options: FetchAlertsOptions
): Promise<unknown> {
  const baseUrl = options.baseUrl.replace(/\/$/, '')
  const qs = buildAlertsQuery(options.filters).toString()
  const url = `${baseUrl}/v0/orgs/${encodeURIComponent(options.orgSlug)}/alerts${qs ? `?${qs}` : ''}`

  const fetchFn = options.fetchFn ?? fetch
  const headers: Record<string, string> = { accept: 'application/json' }
  if (options.userAgent) headers['user-agent'] = options.userAgent
  if (options.authToken) headers['authorization'] = `Bearer ${options.authToken}`
  if (options.extraHeaders) Object.assign(headers, options.extraHeaders)

  const res = await fetchFn(url, { headers })
  if (!res.ok) {
    throw new Error(`alerts endpoint ${res.status}: ${await res.text()}`)
  }
  return res.json()
}
